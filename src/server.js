import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mergeConfig, readOverlay, registerAdminRoutes } from './admin.js'
import { clampLimits } from './limits.js'
import { VERSION } from './version.js'
import { ModelCatalog } from './dsh/catalog.js'
import { SessionMirror, toolResultEvent, userMessageEvent } from './mirror.js'
import { MappingStore } from './session/registry.js'
import { deriveSessionKey, resolveExternalKey, sessionKeyHash } from './session/key.js'
import { firstUserText, systemText, toDshMessages, toDshTools } from './openai/convert.js'
import { ApiError, badRequest, fromLlmFailure, notFound, toOpenAiBody } from './openai/errors.js'
import {
  CompletionCollector,
  SseWriter,
  StopMatcher,
  newCompletionId,
  toFinishReason,
  toOpenAiUsage,
} from './openai/stream.js'

/**
 * Build the OpenAI-compatible request handler.
 *
 * Deliberately tolerant: unknown request fields are ignored (clients routinely
 * send fields this build does not model), while the few that change semantics
 * are rejected explicitly.
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {{ stream: Function, listProviders: Function, listModels: Function }} deps.llm
 * @param {ModelCatalog} deps.catalog
 * @param {SessionMirror | undefined} deps.mirror
 * @param {MappingStore | undefined} deps.registry
 * @param {(level: string, message: string) => void} deps.log
 */
export function createHandler(deps) {
  return async function handler(req, res) {
    const requestId = `req_${randomUUID().replaceAll('-', '').slice(0, 24)}`
    res.setHeader('x-request-id', requestId)
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, {
          ok: true,
          object: 'dsh-endpoint.health',
          version: VERSION,
          providers: deps.catalog.providers().map((provider) => provider.id),
        })
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return sendJson(res, 200, { object: 'list', data: await deps.catalog.list() })
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
        const id = decodeURIComponent(url.pathname.slice('/v1/models/'.length))
        const found = (await deps.catalog.list()).find((model) => model.id === id)
        if (found === undefined) throw notFound(`model "${id}" not found`)
        return sendJson(res, 200, found)
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJson(req, deps.config.limits.maxBodyBytes)
        return await handleChat(req, res, body, deps, requestId)
      }
      if (req.method === 'POST' && url.pathname === '/v1/completions') {
        throw badRequest('the legacy /v1/completions endpoint is not supported; use /v1/chat/completions')
      }
      throw new ApiError(404, 'invalid_request_error', `unknown route ${req.method} ${url.pathname}`)
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(500, 'api_error', String(error?.message ?? error))
      if (res.headersSent) {
        res.end()
        return
      }
      sendJson(res, apiError.status, toOpenAiBody(apiError, requestId))
    }
  }
}

async function handleChat(req, res, body, deps, requestId) {
  const { config, catalog, mirror, registry, log } = deps
  if (body === null || typeof body !== 'object') throw badRequest('request body must be a JSON object')

  if (body.n !== undefined && body.n !== 1) throw badRequest('`n` values above 1 are not supported', 'n')
  if (body.tool_choice !== undefined && body.tool_choice !== null && body.tool_choice !== 'auto') {
    throw badRequest('only `tool_choice: "auto"` is supported', 'tool_choice')
  }

  const route = catalog.resolve(body.model)
  const wantsStream = body.stream === true
  const messages = await toDshMessages(body.messages, route, {
    saveImages: deps.saveImages,
    maxTextBytes: config.limits.maxTextFileBytes,
  })
  const tools = toDshTools(body.tools)

  const identity =
    resolveExternalKey({ headers: req.headers, body, headerName: config.session.header }) ??
    deriveSessionKey({
      model: route.id,
      systemText: systemText(body.messages),
      firstUserText: firstUserSignal(body.messages),
      deriveFrom: config.session.deriveFrom,
    }) ?? { key: `auto:mint:${randomUUID()}`, source: 'minted' }

  const hash = sessionKeyHash(identity.key)
  const turn = await prepareTurn({ body, converted: messages, identity, hash, route, deps })
  res.setHeader(config.session.header, turn.sessionId)

  if (turn.state !== undefined) {
    try {
      mirror.beginTurn(turn.state, turn.events)
    } catch (error) {
      log('warn', `could not open mirrored turn: ${String(error?.message ?? error)}`)
      turn.state = undefined
    }
  }

  const collector = new CompletionCollector()
  const stop = new StopMatcher(normaliseStop(body.stop))
  const controller = new AbortController()
  const abort = () => controller.abort()
  req.on('close', abort)

  const created = Math.floor(Date.now() / 1000)
  const completionId = newCompletionId()
  const writer = wantsStream
    ? beginSse(res, { id: completionId, created, model: route.id, sessionHeader: config.session.header, sessionId: turn.sessionId })
    : undefined

  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    // Provider-side cache/routing affinity. Several gateways (opencode-go
    // among them) reject requests that carry no session identity, and pi-ai
    // forwards this value as their affinity header. It is derived from the
    // conversation key, so it is stable across requests and restarts.
    sessionId: affinityId(identity.key),
    signal: controller.signal,
  }
  if (tools !== undefined) options.tools = tools
  if (Number.isFinite(body.temperature)) options.temperature = body.temperature
  const requestedMax = Number.isFinite(body.max_tokens) ? body.max_tokens : body.max_completion_tokens
  const maxTokens = Number.isFinite(requestedMax)
    ? Math.max(1, Math.min(requestedMax, config.limits.maxOutputTokens))
    : undefined
  if (maxTokens !== undefined) options.maxTokens = maxTokens

  let stopHit = false
  let failure
  try {
    for await (const chunk of deps.llm.stream(options)) {
      if (chunk?.type === 'text-delta' && stop.active) {
        const emitted = stop.push(chunk.text)
        if (emitted.text.length > 0) {
          collector.push({ ...chunk, text: emitted.text })
          writer?.chunk({ ...chunk, text: emitted.text })
        }
        if (emitted.hit) {
          stopHit = true
          break
        }
        continue
      }
      collector.push(chunk)
      writer?.chunk(chunk)
      if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure
    }
    if (!stopHit && stop.active) {
      const tail = stop.flush()
      if (tail.length > 0) {
        collector.push({ type: 'text-delta', index: 0, text: tail })
        writer?.chunk({ type: 'text-delta', index: 0, text: tail })
      }
    }
  } catch (error) {
    failure = { code: error?.code ?? 'INTERNAL', message: String(error?.message ?? error) }
  } finally {
    req.off('close', abort)
  }

  const usage = collector.usage
  if (failure !== undefined) {
    const apiError = fromLlmFailure(failure)
    await finishTurn({ turn, hash, deps, route, collector, usage, failure: apiError })
    log('warn', `model call failed: ${apiError.message}`)
    if (writer !== undefined) {
      writer.writeError(toOpenAiBody(apiError, requestId))
      writer.end()
      return undefined
    }
    throw apiError
  }

  const finishReason = stopHit ? 'stop' : toFinishReason(collector.finishReason)
  if (writer !== undefined) {
    writer.finish(collector.finishReason)
    if (body.stream_options?.include_usage === true) writer.usage(usage)
    writer.end()
  } else {
    const message = { role: 'assistant', content: collector.text }
    if (collector.reasoning.length > 0) message.reasoning_content = collector.reasoning
    if (collector.toolCalls.length > 0) {
      message.tool_calls = collector.toolCalls.map((call, index) => ({
        index,
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }))
      message.content = collector.text.length > 0 ? collector.text : null
    }
    sendJson(res, 200, {
      id: completionId,
      object: 'chat.completion',
      created,
      model: route.id,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: toOpenAiUsage(usage),
    })
  }

  await finishTurn({ turn, hash, deps, route, collector, usage })
  return undefined
}

/**
 * Resolve (or create) the mirror session for this conversation and work out
 * which client messages are new since the last recorded turn.
 */
async function prepareTurn({ body, converted, identity, hash, route, deps }) {
  const { mirror, registry, log } = deps
  // Keep the raw message for the prefix hash (stable across re-uploads) and the
  // converted one for the event, so images land in the mirror as attachment
  // references instead of being flattened to text.
  const sides = []
  body.messages.forEach((message, index) => {
    if (message?.role !== 'user' && message?.role !== 'tool') return
    sides.push({ raw: message, converted: converted[index] })
  })
  const hashes = sides.map((side) => hashMessage(side.raw))

  if (mirror === undefined || registry === undefined) {
    return { sessionId: echoable(identity.key, hash), state: undefined, events: [], hashes }
  }

  try {
    const entry = registry.get(hash)
    if (entry !== undefined) {
      const recorded = entry.userHashes ?? []
      const prefixMatches = recorded.every((recordedHash, index) => hashes[index] === recordedHash)
      if (prefixMatches) {
        let state
        try {
          state = await mirror.ensure(entry)
        } catch (error) {
          if (!isMissingSession(error)) throw error
          log('warn', `mirrored session ${entry.dshSessionId} is gone; creating a replacement`)
          const created = await mirror.create()
          await registry.bind(hash, {
            externalKey: identity.key,
            source: identity.source,
            dshSessionId: created.dshSessionId,
            workspacePath: mirror.workspacePath,
            model: route.id,
          })
          return {
      sessionId: created.dshSessionId,
      state: created.state,
      events: sides.map((side) => toEvent(side.converted)),
      hashes,
    }
        }
        return {
          sessionId: entry.dshSessionId,
          state,
          events: sides.slice(recorded.length).map((side) => toEvent(side.converted)),
          hashes,
        }
      }
      log('warn', `client history diverged for "${identity.key}"; starting a new DSH session`)
    }
    const created = await mirror.create()
    await registry.bind(hash, {
      externalKey: identity.key,
      source: identity.source,
      dshSessionId: created.dshSessionId,
      workspacePath: mirror.workspacePath,
      model: route.id,
    })
    return {
      sessionId: created.dshSessionId,
      state: created.state,
      events: sides.map((side) => toEvent(side.converted)),
      hashes,
    }
  } catch (error) {
    log('warn', `session mirror unavailable for this request: ${String(error?.message ?? error)}`)
    return { sessionId: echoable(identity.key, hash), state: undefined, events: [], hashes }
  }
}

async function finishTurn({ turn, hash, deps, route, collector, usage, failure }) {
  const { mirror, registry, log } = deps
  if (mirror === undefined || registry === undefined || turn.state === undefined) return
  try {
    if (failure === undefined) {
      mirror.completeTurn(turn.state, {
        blocks: collector.blocks,
        chunks: collector.chunks,
        usage,
        provider: route.provider,
        model: route.model,
      })
    } else {
      mirror.failTurn(turn.state, { message: failure.message, code: failure.code ?? 'api_error' })
    }
    const entry = registry.get(hash)
    if (entry !== undefined) {
      await registry.update(hash, {
        turns: turn.state.turn,
        requests: entry.requests + 1,
        inputTokens: entry.inputTokens + (usage?.inputTokens ?? 0),
        outputTokens: entry.outputTokens + (usage?.outputTokens ?? 0),
        userHashes: turn.hashes,
        model: route.id,
      })
    }
    void mirror.flush(turn.state)
  } catch (error) {
    log('warn', `could not record mirrored turn: ${String(error?.message ?? error)}`)
  }
}

/** Deterministic UUID-shaped affinity id for one conversation. */
function affinityId(key) {
  const h = createHash('sha256').update(`dsh-endpoint-affinity\u0000${key}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Header values must be a single ASCII line; fall back to the opaque hash. */
function echoable(key, hash) {
  return /^[\x20-\x7e]{1,200}$/.test(key) ? key : `unmirrored-${hash.slice(0, 8)}`
}

/**
 * The mirror records text only; media parts become a stable placeholder so an
 * image-only message still produces a valid `user/message` event.
 */
/** Converted DSH message -> mirror surface event (keeps image/file references). */
function toEvent(message) {
  if (message.role === 'tool') {
    return toolResultEvent({
      callId: message.toolCallId,
      text: textOfBlocks(message.content),
      isError: message.isError === true,
    })
  }
  return userMessageEvent(message.content)
}

function textOfBlocks(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * Fingerprint input for the first user message. Text is preferred; an
 * image-only opener falls back to a hash of its parts so the conversation key
 * stays stable instead of minting a new session per request.
 */
function firstUserSignal(messages) {
  const text = firstUserText(messages)
  if (text.length > 0) return text
  const first = messages.find((message) => message?.role === 'user')
  if (first === undefined) return ''
  const parts = JSON.stringify(first.content ?? '')
  return `parts:${createHash('sha256').update(parts).digest('hex').slice(0, 32)}`
}


function hashMessage(message) {
  return createHash('sha256')
    .update(JSON.stringify([message.role, message.content ?? null, message.tool_call_id ?? null]))
    .digest('hex')
    .slice(0, 32)
}

function normaliseStop(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  return []
}

function beginSse(res, { id, created, model, sessionHeader, sessionId }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    [sessionHeader]: sessionId,
  })
  const writer = new SseWriter({ res, id, created, model })
  writer.start()
  return writer
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJson(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw badRequest(`request body exceeds ${limit} bytes`)
    chunks.push(chunk)
  }
  if (chunks.length === 0) throw badRequest('request body is empty')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw badRequest('request body is not valid JSON')
  }
}

/**
 * Start the listener and return its disposer.
 *
 * @param {object} ctx
 * @param {object} config
 * @param {{ log: (level: string, message: string) => void }} options
 */
export async function startEndpoint(ctx, config, options) {
  const log = options.log
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('dsh-endpoint: ctx.llm is not available in this profile')

  const root = options.stateRoot ?? resolveStateRoot(ctx)
  const overlay = await readOverlay(root)
  const effective = mergeConfig(config, overlay)
  effective.limits = clampLimits(effective.limits ?? {}, log)

  const catalog = new ModelCatalog(llm, {
    aliases: effective.modelAliases,
    defaultModel: effective.defaultModel,
    log,
  })

  let mirror
  let registry
  if (effective.session.mirror === true) {
    const workspacePath = effective.session.workspacePath || join(root, 'conversations')
    registry = new MappingStore(join(root, 'state.json'), { log })
    await registry.open()
    mirror = new SessionMirror(ctx, { workspacePath, log })
  }

  let sweepTimer
  if (mirror !== undefined && registry !== undefined) {
    const sweep = () => void sweepExpired(ctx, registry, mirror, effective, log)
    sweepTimer = setInterval(sweep, 60 * 60 * 1000)
    sweepTimer.unref?.()
    const first = setTimeout(sweep, 10_000)
    first.unref?.()
  }

  const attachments = ctx.get('attachments')
  const saveImages =
    attachments === undefined ? undefined : (inputs) => attachments.saveImages(inputs)
  const handler = createHandler({
    config: effective,
    llm,
    catalog,
    mirror,
    registry,
    log,
    saveImages,
  })
  let current = await listenOn(handler, effective.host, effective.port)
  logListening(effective, current.port, log)

  // Serialized listener swaps: the settings page can move host/port without a
  // plugin reload. A failed bind restores the previous address instead of
  // leaving the endpoint down.
  let rebindChain = Promise.resolve()
  const rebind = (nextHost, nextPort) => {
    rebindChain = rebindChain.then(async () => {
      const previous = { host: effective.host, port: current.port }
      await closeServer(current.server)
      try {
        current = await listenOn(handler, nextHost, nextPort)
      } catch (error) {
        try {
          current = await listenOn(handler, previous.host, previous.port)
        } catch {
          current = { server: undefined, port: previous.port }
        }
        throw new Error(`cannot listen on ${formatHost(nextHost)}:${nextPort}: ${error?.message ?? error}`)
      }
      effective.host = nextHost
      effective.port = nextPort
      logListening(effective, current.port, log)
    })
    return rebindChain
  }

  registerAdminRoutes(ctx, {
    root,
    log,
    getConfig: () => effective,
    onSave: async (next, patch) => {
      const hostChanged = patch.host !== undefined && patch.host !== effective.host
      const portChanged = patch.port !== undefined && Number(patch.port) !== effective.port
      if (hostChanged || portChanged) await rebind(next.host, next.port)
      for (const key of Object.keys(next)) effective[key] = next[key]
      effective.limits = clampLimits(next.limits ?? {}, log)
      catalog.aliases = next.modelAliases ?? {}
      catalog.defaultModel = next.defaultModel ?? ''
    },
    getState: async () => ({
      version: VERSION,
      url: `http://${formatHost(effective.host)}:${current.port}`,
      host: effective.host,
      port: current.port,
      providers: catalog.providers().map((provider) => provider.id),
      sessions: registry?.list().length ?? 0,
      mirror: effective.session.mirror,
      stateRoot: root,
    }),
  })

  const dispose = async () => {
    if (sweepTimer !== undefined) clearInterval(sweepTimer)
    await rebindChain.catch(() => {})
    await closeServer(current.server)
    await mirror?.close()
    await registry?.close()
  }

  return {
    port: current.port,
    url: `http://${formatHost(effective.host)}:${current.port}`,
    dispose,
  }
}

function listenOn(handler, host, port) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler)
    server.keepAliveTimeout = 65_000
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : port })
    })
  })
}

async function closeServer(server) {
  if (server === undefined) return
  await new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}

function logListening(config, port, log) {
  log('info', `dsh-endpoint listening on http://${formatHost(config.host)}:${port}`)
  if (config.host === '0.0.0.0') {
    log(
      'warn',
      'dsh-endpoint is bound to 0.0.0.0 without authentication; anyone who can reach this port can spend your model quota',
    )
  }
}

async function sweepExpired(ctx, registry, mirror, config, log) {
  try {
    const expired = await registry.expire(config.session.mappingTtlDays)
    for (const entry of expired) {
      const state = mirror.states.get(entry.dshSessionId)
      if (state !== undefined) {
        await mirror.flush(state)
        await state.handle?.close?.().catch(() => {})
        mirror.states.delete(entry.dshSessionId)
      }
      if (config.session.archiveOnExpire === true) {
        try {
          await ctx.get('workspaceRegistry')?.archiveSession?.(entry.dshSessionId)
        } catch (error) {
          log('warn', `could not archive ${entry.dshSessionId}: ${String(error?.message ?? error)}`)
        }
      }
      log('info', `expired mapping ${entry.externalKey} -> ${entry.dshSessionId}`)
    }
  } catch (error) {
    log('warn', `mapping sweep failed: ${String(error?.message ?? error)}`)
  }
}

function isMissingSession(error) {
  const name = String(error?.name ?? '')
  const message = String(error?.message ?? '')
  return name.includes('NotFound') || message.includes('not found')
}

function resolveStateRoot(ctx) {
  try {
    const homePath = ctx.get('dshHomePath')
    if (typeof homePath === 'function') {
      const resolved = homePath('dsh-endpoint')
      if (typeof resolved === 'string' && resolved.length > 0) return resolved
    }
  } catch {
    // fall through to DSH_HOME
  }
  const base = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, 'dsh-endpoint')
}

function formatHost(host) {
  return host.includes(':') ? `[${host}]` : host
}
