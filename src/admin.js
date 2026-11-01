import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Fields the settings page may write into the user overlay. */
const CONFIG_KEYS = ['host', 'port', 'defaultModel', 'modelAliases', 'session', 'limits', 'log']

/**
 * The page writes a user overlay (`$DSH_HOME/dsh-endpoint/config.json`) instead
 * of the Cordis entry config: the browser cannot reach the loader, and this is
 * the same two-layer shape other plugins use (bootstrap config + user file).
 */
export async function readOverlay(root) {
  try {
    const raw = await readFile(join(root, 'config.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
}

export async function writeOverlay(root, overlay) {
  await mkdir(root, { recursive: true })
  const file = join(root, 'config.json')
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(overlay, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/** Deep-merge the user overlay over the entry config for the keys we own. */
export function mergeConfig(base, overlay) {
  const out = { ...base }
  for (const key of CONFIG_KEYS) {
    if (!Object.hasOwn(overlay, key)) continue
    const next = overlay[key]
    const current = base[key]
    if (isPlainObject(next) && isPlainObject(current)) out[key] = { ...current, ...next }
    else out[key] = next
  }
  return out
}

/**
 * Validate and normalise a patch coming from the settings page.
 * @returns {{ patch: object, restartRequired: boolean }}
 */
export function normalisePatch(input, base) {
  if (!isPlainObject(input)) throw new Error('body must be a JSON object')
  const patch = {}
  let restartRequired = false
  let rebind = false

  if ('host' in input) {
    const host = input.host
    if (typeof host !== 'string' || host.length === 0) throw new Error('host must be a non-empty string')
    if (host !== base.host) rebind = true
    patch.host = host
  }
  if ('port' in input) {
    const port = Number(input.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer 0-65535')
    if (port !== base.port) rebind = true
    patch.port = port
  }
  if ('defaultModel' in input) {
    if (typeof input.defaultModel !== 'string') throw new Error('defaultModel must be a string')
    patch.defaultModel = input.defaultModel
  }
  if ('modelAliases' in input) {
    if (!isPlainObject(input.modelAliases)) throw new Error('modelAliases must be an object')
    for (const [name, target] of Object.entries(input.modelAliases)) {
      if (typeof target !== 'string' || !target.includes('/')) {
        throw new Error(`modelAliases.${name} must be "provider/model"`)
      }
    }
    patch.modelAliases = input.modelAliases
  }
  if ('session' in input) {
    const session = input.session
    if (!isPlainObject(session)) throw new Error('session must be an object')
    const next = {}
    if ('mirror' in session) {
      if (typeof session.mirror !== 'boolean') throw new Error('session.mirror must be a boolean')
      if (session.mirror !== base.session.mirror) restartRequired = true
      next.mirror = session.mirror
    }
    if ('mappingTtlDays' in session) {
      const days = Number(session.mappingTtlDays)
      if (!Number.isFinite(days) || days < 0) throw new Error('session.mappingTtlDays must be >= 0')
      next.mappingTtlDays = days
    }
    if ('workspacePath' in session) {
      if (typeof session.workspacePath !== 'string') throw new Error('session.workspacePath must be a string')
      if (session.workspacePath !== base.session.workspacePath) restartRequired = true
      next.workspacePath = session.workspacePath
    }
    patch.session = next
  }

  return { patch, restartRequired, rebind }
}

/** Register the settings-page routes on the GUI web server (loopback only). */
export function registerAdminRoutes(ctx, options) {
  if (typeof ctx?.inject !== 'function') return
  const { root, getConfig, onSave, getState, log } = options
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-endpoint',
        handler: (req, res) => {
          void handleAdmin(req, res, { root, getConfig, onSave, getState, log })
        },
      }),
    )
  })
}

async function handleAdmin(req, res, { root, getConfig, onSave, getState, log }) {
  if (!isLoopback(req.socket?.remoteAddress)) {
    return sendJson(res, 403, { error: 'loopback only' })
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/dsh-endpoint/state') {
      return sendJson(res, 200, await getState())
    }
    if (req.method === 'GET' && url.pathname === '/dsh-endpoint/config') {
      return sendJson(res, 200, getConfig())
    }
    if (req.method === 'PUT' && url.pathname === '/dsh-endpoint/config') {
      const body = await readJson(req)
      const { patch, restartRequired, rebind } = normalisePatch(body, getConfig())
      const current = await readOverlay(root)
      const overlay = { ...current, ...patch, ...(patch.session ? { session: { ...(current.session ?? {}), ...patch.session } } : {}) }
      await writeOverlay(root, overlay)
      const effective = mergeConfig(getConfig(), overlay)
      await onSave?.(effective, patch)
      log?.(
        'info',
        `settings page saved config${rebind ? ' (listener rebound)' : ''}${restartRequired ? ' (restart required)' : ''}`,
      )
      return sendJson(res, 200, { saved: true, restartRequired, rebound: rebind, config: effective })
    }
    return sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    return sendJson(res, 400, { error: String(error?.message ?? error) })
  }
}

function isLoopback(address) {
  if (typeof address !== 'string') return false
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
