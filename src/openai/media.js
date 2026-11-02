import { badRequest } from './errors.js'

const IMAGE_TYPES = new Map([
  ['image/png', 'image/png'],
  ['image/jpeg', 'image/jpeg'],
  ['image/jpg', 'image/jpeg'],
  ['image/webp', 'image/webp'],
  ['image/gif', 'image/gif'],
])

const TEXT_TYPES = [
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
  'application/sql',
]

const DEFAULT_TEXT_MAX_BYTES = 8 * 1024 * 1024

/**
 * Parse one `data:` URL. Remote URLs are rejected on purpose: the endpoint
 * must not fetch arbitrary hosts on behalf of a client (SSRF), and every
 * supported client can inline base64.
 *
 * @param {string} url
 * @param {string} param
 * @returns {{ mediaType: string, data: Buffer }}
 */
export function parseDataUrl(url, param) {
  if (typeof url !== 'string' || url.length === 0) throw badRequest(`${param} must be a string`, param)
  if (/^https?:/i.test(url)) {
    throw badRequest(
      'remote file URLs are not supported; send a data: URL with base64 content instead',
      param,
    )
  }
  const match = /^data:([^;,]+)((?:;[^,]*)*?),(.*)$/s.exec(url)
  if (match === null) throw badRequest(`${param} must be a data: URL`, param)
  const mediaType = match[1].trim().toLowerCase()
  const parameters = match[2] ?? ''
  const payload = match[3] ?? ''
  let data
  if (/;base64/i.test(parameters)) {
    // The request body cap is the real gate; by the time we get here the whole
    // body is already bounded by `limits.maxBodyBytes`.
    data = Buffer.from(payload, 'base64')
  } else {
    data = Buffer.from(decodeURIComponent(payload), 'utf8')
  }
  if (data.length === 0) throw badRequest(`${param} is empty`, param)
  return { mediaType, data }
}

/** Normalise an image media type, or `undefined` when it is not a raster image. */
export function imageMediaType(mediaType) {
  return IMAGE_TYPES.get(mediaType)
}

/** Whether a media type should be inlined as UTF-8 text. */
export function isTextMediaType(mediaType) {
  return mediaType.startsWith('text/') || TEXT_TYPES.includes(mediaType)
}

/**
 * Decode one inline file (image or text) into a DSH content block.
 *
 * @param {object} input
 * @param {string} input.url - data URL
 * @param {string} [input.name] - original filename
 * @param {string} input.param - request path for error messages
 * @param {object} options
 * @param {(inputs: Array<{ data: Uint8Array, mediaType: string, name?: string }>) => Promise<Array<object>>} [options.saveImages]
 * @param {boolean} [options.allowText]
 * @returns {Promise<object>} text or image block
 */
export async function decodeInlineFile({ url, name, param }, options = {}) {
  const { mediaType, data } = parseDataUrl(url, param)
  const image = imageMediaType(mediaType)
  if (image !== undefined) {
    if (typeof options.saveImages !== 'function') {
      throw badRequest('image input is not available in this profile', param)
    }
    const [ref] = await options.saveImages([{ data: new Uint8Array(data), mediaType: image, ...(name ? { name } : {}) }])
    if (ref === undefined) throw badRequest('could not store the image attachment', param)
    return { type: 'image', attachment: ref }
  }
  if (isTextMediaType(mediaType) && options.allowText === true) {
    const limit =
      Number.isFinite(options.maxTextBytes) && options.maxTextBytes > 0
        ? Math.floor(options.maxTextBytes)
        : DEFAULT_TEXT_MAX_BYTES
    const truncated = data.length > limit
    const text = data.subarray(0, limit).toString('utf8')
    const header = `[file${name ? `: ${name}` : ''}${truncated ? ', truncated' : ''}]\n`
    return { type: 'text', text: header + text }
  }
  throw badRequest(
    `unsupported inline media type "${mediaType}"; images and text files are supported, other documents must be sent as text`,
    param,
  )
}

/**
 * OpenAI `file` content part: `{ type: 'file', file: { filename, file_data } }`.
 * `file_id` refers to the Files API, which this endpoint does not implement.
 */
export async function decodeFilePart(part, param, options = {}) {
  const file = part?.file
  if (file === null || typeof file !== 'object') throw badRequest(`${param}.file is required`, param)
  if (typeof file.file_id === 'string') {
    throw badRequest('file_id is not supported; inline the bytes as file_data', `${param}.file.file_id`)
  }
  const fileData = file.file_data ?? file.data
  if (typeof fileData !== 'string') {
    throw badRequest(`${param}.file.file_data is required`, `${param}.file.file_data`)
  }
  return decodeInlineFile(
    { url: fileData, name: typeof file.filename === 'string' ? file.filename : undefined, param },
    { ...options, allowText: true },
  )
}
