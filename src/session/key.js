import { createHash } from 'node:crypto'

/**
 * Headers that other agents/tools use to carry a conversation identity. Order
 * is precedence: the first non-empty one wins. These are hard-coded on
 * purpose — the endpoint must be client-agnostic, not configurable per client.
 */
export const SESSION_HEADERS = [
  'x-session-id',
  'session-id',
  'x-conversation-id',
  'conversation-id',
  'x-chat-id',
  'x-thread-id',
  'x-agent-session-id',
  'x-claude-code-session-id',
  'x-codex-session-id',
]

/**
 * Request-body fields probed in order after the headers. `user` is the OpenAI
 * standard field and sits last because it identifies an end user, not a
 * conversation.
 */
export const BODY_KEYS = [
  'session_id',
  'conversation_id',
  'chat_id',
  'thread_id',
  'metadata.session_id',
  'metadata.conversation_id',
  'user',
]

/** Headers that look like session ids but are per-request trace ids. */
export const NON_SESSION_HEADERS = ['x-request-id', 'x-correlation-id', 'x-trace-id']

export function fingerprint(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

/** Trim and reject values that cannot be a usable conversation key. */
export function normalizeKey(raw) {
  if (typeof raw !== 'string') return undefined
  const key = raw.trim()
  if (key.length === 0 || key.length > 512) return undefined
  if (/[\u0000-\u001f\u007f]/.test(key)) return undefined
  return key
}

export function readHeader(headers, name) {
  if (headers === undefined || headers === null) return undefined
  const lower = name.toLowerCase()
  let value = headers[lower]
  if (value === undefined) {
    // Node lower-cases header names, but callers may hand us a plain object.
    const match = Object.keys(headers).find((key) => key.toLowerCase() === lower)
    if (match !== undefined) value = headers[match]
  }
  return Array.isArray(value) ? value[0] : value
}

function readPath(body, path) {
  let value = body
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined
    value = value[part]
  }
  return value
}

/**
 * Resolve the client-owned conversation identity, or `undefined` when the
 * request carries none.
 *
 * @param {object} input
 * @param {object} input.headers - lower-cased request headers
 * @param {object} input.body - parsed JSON body
 * @param {string} input.headerName - this plugin's own session header
 * @returns {{ key: string, source: string } | undefined}
 */
export function resolveExternalKey({ headers, body, headerName = 'x-dsh-session-id' }) {
  const ownHeader = headerName.toLowerCase()
  const own = normalizeKey(readHeader(headers, ownHeader))
  if (own !== undefined) return { key: own, source: `header:${ownHeader}` }

  for (const name of SESSION_HEADERS) {
    const value = normalizeKey(readHeader(headers, name))
    if (value !== undefined) return { key: value, source: `header:${name}` }
  }

  for (const path of BODY_KEYS) {
    const value = normalizeKey(readPath(body, path))
    if (value !== undefined) return { key: value, source: `body:${path}` }
  }

  return undefined
}

/**
 * Deterministic fallback identity for clients that carry no session id at
 * all. Never random: the same conversation must resolve to the same key on
 * every request and across restarts.
 *
 * @param {object} input
 * @param {string} input.model - resolved `provider/model`
 * @param {string} [input.systemText] - concatenated system/developer text
 * @param {string} [input.firstUserText] - text of the first user message
 * @param {readonly string[]} input.deriveFrom - selected fingerprint inputs
 * @returns {{ key: string, source: string } | undefined}
 */
export function deriveSessionKey({ model, systemText, firstUserText, deriveFrom }) {
  const inputs = Array.isArray(deriveFrom) && deriveFrom.length > 0 ? deriveFrom : ['model', 'first-user']
  const parts = []
  if (inputs.includes('model')) parts.push(`model:${model}`)
  if (inputs.includes('system') && typeof systemText === 'string' && systemText.length > 0) {
    parts.push(`system:${systemText}`)
  }
  if (inputs.includes('first-user') && typeof firstUserText === 'string' && firstUserText.length > 0) {
    parts.push(`user:${firstUserText}`)
  }
  if (parts.length === 0) return undefined
  return { key: `auto:${fingerprint(parts.join('\u0000')).slice(0, 32)}`, source: 'derived' }
}

/** Stable storage key for an external identity of any length or charset. */
export function sessionKeyHash(externalKey) {
  return fingerprint(`dsh-endpoint\u0000${externalKey}`).slice(0, 32)
}
