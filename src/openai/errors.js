/** OpenAI-shaped errors, mapped from DSH's stable failure codes. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} type
   * @param {string} message
   * @param {{ code?: string, param?: string }} [extra]
   */
  constructor(status, type, message, extra = {}) {
    super(message)
    this.status = status
    this.type = type
    this.code = extra.code
    this.param = extra.param
  }
}

export function badRequest(message, param) {
  return new ApiError(400, 'invalid_request_error', message, { param })
}

export function notFound(message) {
  return new ApiError(404, 'model_not_found', message, { code: 'model_not_found' })
}

const CODE_MAP = {
  AUTH: [401, 'authentication_error', 'authentication_error'],
  INVALID_CREDENTIAL: [401, 'authentication_error', 'invalid_api_key'],
  MISSING_CREDENTIAL: [503, 'api_error', 'missing_credential'],
  RATE_LIMIT: [429, 'rate_limit_error', 'rate_limit_exceeded'],
  QUOTA: [429, 'insufficient_quota', 'insufficient_quota'],
  ACCOUNT_QUOTA: [429, 'insufficient_quota', 'insufficient_quota'],
  CONTEXT_WINDOW_EXCEEDED: [400, 'invalid_request_error', 'context_length_exceeded'],
  NO_ADAPTER: [404, 'model_not_found', 'model_not_found'],
  UNKNOWN_MODEL: [404, 'model_not_found', 'model_not_found'],
  INVALID_MODEL_INFO: [404, 'model_not_found', 'model_not_found'],
  INVALID_MODEL_CONTEXT: [404, 'model_not_found', 'model_not_found'],
  INVALID_MODEL_MAX_TOKENS: [404, 'model_not_found', 'model_not_found'],
  UNSUPPORTED_OPTION: [400, 'invalid_request_error', 'unsupported_parameter'],
  IMAGE_OFFLOAD_REQUIRED: [400, 'invalid_request_error', 'image_too_large'],
}

/**
 * Map a DSH failure (`{ code, message }`) to an OpenAI error.
 * @param {{ code?: string, message?: string }} failure
 */
export function fromLlmFailure(failure) {
  const code = typeof failure?.code === 'string' ? failure.code : undefined
  const message = typeof failure?.message === 'string' ? failure.message : 'model call failed'
  const mapped = code === undefined ? undefined : CODE_MAP[code]
  if (mapped === undefined) {
    return new ApiError(500, 'api_error', message, { code: code ?? 'internal_error' })
  }
  const [status, type, openaiCode] = mapped
  return new ApiError(status, type, message, { code: openaiCode })
}

export function toOpenAiBody(error, requestId) {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: error.param ?? null,
      code: error.code ?? null,
    },
    ...(requestId === undefined ? {} : { request_id: requestId }),
  }
}
