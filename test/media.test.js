import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeInlineFile, imageMediaType, isTextMediaType, parseDataUrl } from '../src/openai/media.js'
import { ApiError } from '../src/openai/errors.js'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('base64 data URLs decode to bytes and media type', () => {
  const parsed = parseDataUrl(`data:image/png;base64,${PNG_B64}`, 'img')
  assert.equal(parsed.mediaType, 'image/png')
  assert.ok(parsed.data.length > 50)
})

test('percent-encoded data URLs decode as UTF-8', () => {
  const parsed = parseDataUrl('data:text/plain,hello%20world', 'f')
  assert.equal(parsed.mediaType, 'text/plain')
  assert.equal(parsed.data.toString('utf8'), 'hello world')
})

test('remote URLs and malformed payloads are refused', () => {
  assert.throws(() => parseDataUrl('https://example.com/a.png', 'img'), ApiError)
  assert.throws(() => parseDataUrl('not-a-data-url', 'img'), ApiError)
  assert.throws(() => parseDataUrl('data:image/png;base64,', 'img'), ApiError)
})

test('image media types normalise and text types are detected', () => {
  assert.equal(imageMediaType('image/jpg'), 'image/jpeg')
  assert.equal(imageMediaType('image/png'), 'image/png')
  assert.equal(imageMediaType('application/pdf'), undefined)
  assert.equal(isTextMediaType('text/markdown'), true)
  assert.equal(isTextMediaType('application/json'), true)
  assert.equal(isTextMediaType('application/pdf'), false)
})

test('inline files decode to content blocks', async () => {
  const image = await decodeInlineFile(
    { url: `data:image/png;base64,${PNG_B64}`, param: 'p' },
    {
      saveImages: async (inputs) => [
        { attachmentId: 'a1', mediaType: inputs[0].mediaType, bytes: inputs[0].data.length, width: 1, height: 1 },
      ],
    },
  )
  assert.equal(image.type, 'image')
  assert.equal(image.attachment.attachmentId, 'a1')

  const text = await decodeInlineFile(
    { url: 'data:text/plain;base64,aGk=', name: 'a.txt', param: 'p' },
    { allowText: true },
  )
  assert.equal(text.type, 'text')
  assert.match(text.text, /a\.txt/)
  assert.match(text.text, /hi/)
})
