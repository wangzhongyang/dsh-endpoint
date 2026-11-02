/**
 * DSH's own buffered-request ceiling: `dsh-client-connection` defaults
 * `maxRequestBodyBytes` to 314572800 (300 MiB) for its `/api` route.
 *
 * This endpoint runs its own listener, so it cannot inherit that value — but it
 * must not go above it either, which is what these helpers enforce.
 */
export const DSH_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024

/**
 * Clamp configured limits to what the host would accept.
 *
 * @param {{ maxBodyBytes?: number, maxTextFileBytes?: number }} limits
 * @param {(level: string, message: string) => void} [log]
 */
export function clampLimits(limits, log = () => {}) {
  const requestedBody = Number.isFinite(limits.maxBodyBytes) ? limits.maxBodyBytes : DSH_MAX_REQUEST_BODY_BYTES
  const body = Math.max(1, Math.min(requestedBody, DSH_MAX_REQUEST_BODY_BYTES))
  const requestedText = Number.isFinite(limits.maxTextFileBytes) ? limits.maxTextFileBytes : body
  const text = Math.max(1, Math.min(requestedText, body))
  if (body !== requestedBody) {
    log('warn', `limits.maxBodyBytes ${requestedBody} exceeds DSH's ${DSH_MAX_REQUEST_BODY_BYTES}; clamped`)
  }
  if (text !== requestedText) {
    log('warn', `limits.maxTextFileBytes ${requestedText} exceeds maxBodyBytes ${body}; clamped`)
  }
  return { ...limits, maxBodyBytes: body, maxTextFileBytes: text }
}
