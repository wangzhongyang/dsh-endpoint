import { randomUUID } from 'node:crypto'
import { badRequest } from './errors.js'
import { decodeFilePart, decodeInlineFile } from './media.js'

/**
 * Convert OpenAI chat messages into DSH request messages.
 *
 * DSH accepts request-only user input, but assistant and tool turns need a
 * full `Message` (identity + source), so every message gets a fresh id. The
 * ids exist only for this request; the durable record is the mirrored session.
 *
 * Inline `image_url` data URLs and `file` parts are materialised through the
 * host attachment service; remote URLs are refused (see `media.js`).
 *
 * @param {Array<object>} messages
 * @param {{ provider: string, model: string }} route
 * @param {{ saveImages?: Function }} [options]
 */
export async function toDshMessages(messages, route, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw badRequest('`messages` must be a non-empty array', 'messages')
  }
  const converted = []
  for (const [index, message] of messages.entries()) {
    converted.push(await toDshMessage(message, index, route, options))
  }
  return converted
}

async function toDshMessage(message, index, route, options) {
  const param = `messages[${index}]`
  if (message === null || typeof message !== 'object') throw badRequest(`${param} must be an object`, param)
  const role = message.role
  if (typeof role !== 'string') throw badRequest(`${param}.role is required`, `${param}.role`)

  if (role === 'system' || role === 'developer') {
    const text = coerceText(message.content, `${param}.content`)
    return {
      id: randomUUID(),
      role: 'system',
      content: text.length === 0 ? [] : [{ type: 'text', text }],
      source: { kind: 'system-prompt' },
    }
  }

  if (role === 'user') {
    return {
      id: randomUUID(),
      role: 'user',
      content: await toContentBlocks(message.content, `${param}.content`, options),
      source: { kind: 'user' },
    }
  }

  if (role === 'assistant') {
    const content = await toContentBlocks(message.content ?? [], `${param}.content`, {
      ...options,
      allowEmpty: true,
      allowMedia: false,
    })
    for (const call of message.tool_calls ?? []) {
      const fn = call?.function
      if (typeof fn?.name !== 'string' || fn.name.length === 0) {
        throw badRequest(`${param}.tool_calls[].function.name is required`, `${param}.tool_calls`)
      }
      content.push({
        type: 'tool-call',
        id: typeof call.id === 'string' && call.id.length > 0 ? call.id : randomUUID(),
        name: fn.name,
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      })
    }
    return {
      id: randomUUID(),
      role: 'assistant',
      content,
      source: { kind: 'model', provider: route.provider, model: route.model },
    }
  }

  if (role === 'tool') {
    const callId = message.tool_call_id
    if (typeof callId !== 'string' || callId.length === 0) {
      throw badRequest(`${param}.tool_call_id is required for tool messages`, `${param}.tool_call_id`)
    }
    return {
      id: randomUUID(),
      role: 'tool',
      toolCallId: callId,
      content: await toContentBlocks(message.content, `${param}.content`, {
        ...options,
        allowEmpty: true,
        allowMedia: false,
      }),
      source: { kind: 'tool', callId },
      ...(message.is_error === true ? { isError: true } : {}),
    }
  }

  throw badRequest(`${param}.role "${role}" is not supported`, `${param}.role`)
}

async function toContentBlocks(content, param, options = {}) {
  if (typeof content === 'string') return content.length === 0 ? [] : [{ type: 'text', text: content }]
  if (content === null || content === undefined) {
    if (options.allowEmpty === true) return []
    throw badRequest(`${param} is required`, param)
  }
  if (!Array.isArray(content)) throw badRequest(`${param} must be a string or an array of parts`, param)

  const blocks = []
  for (const [index, part] of content.entries()) {
    const partParam = `${param}[${index}]`
    if (part === null || typeof part !== 'object') throw badRequest(`${partParam} must be an object`, partParam)

    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw badRequest(`${partParam}.text must be a string`, partParam)
      if (part.text.length > 0) blocks.push({ type: 'text', text: part.text })
      continue
    }

    if (part.type === 'image_url') {
      if (options.allowMedia === false) throw badRequest(`${partParam} is not allowed here`, partParam)
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url !== 'string') throw badRequest(`${partParam}.image_url.url is required`, partParam)
      blocks.push(await safeDecode(partParam, () => decodeInlineFile({ url, param: partParam }, options)))
      continue
    }

    if (part.type === 'file') {
      if (options.allowMedia === false) throw badRequest(`${partParam} is not allowed here`, partParam)
      blocks.push(await safeDecode(partParam, () => decodeFilePart(part, partParam, options)))
      continue
    }

    throw badRequest(`${partParam}.type "${String(part.type)}" is not supported`, `${partParam}.type`)
  }
  if (blocks.length === 0 && options.allowEmpty !== true) throw badRequest(`${param} is empty`, param)
  return blocks
}

async function safeDecode(param, run) {
  try {
    return await run()
  } catch (error) {
    if (error?.status !== undefined) throw error
    throw badRequest(`attachment rejected: ${error?.message ?? error}`, param)
  }
}

function coerceText(content, param) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
  }
  if (content === null || content === undefined) return ''
  throw badRequest(`${param} must be a string or an array of text parts`, param)
}

/** Concatenated system/developer text, used by the fingerprint fallback. */
export function systemText(messages) {
  return messages
    .filter((message) => message?.role === 'system' || message?.role === 'developer')
    .map((message) => coerceText(message.content, 'messages'))
    .join('\n')
}

/** Text of the first user message, used by the fingerprint fallback. */
export function firstUserText(messages) {
  const first = messages.find((message) => message?.role === 'user')
  return first === undefined ? '' : coerceText(first.content, 'messages')
}

/** Convert OpenAI tool declarations into DSH tool schemas. */
export function toDshTools(tools) {
  if (tools === undefined || tools === null) return undefined
  if (!Array.isArray(tools)) throw badRequest('`tools` must be an array', 'tools')
  const declarations = []
  for (const [index, tool] of tools.entries()) {
    const fn = tool?.type === 'function' ? tool.function : undefined
    if (fn === undefined || typeof fn.name !== 'string' || fn.name.length === 0) {
      throw badRequest(`tools[${index}] must be a function declaration with a name`, `tools[${index}]`)
    }
    declarations.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters:
        fn.parameters !== null && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
    })
  }
  return declarations.length === 0 ? undefined : declarations
}
