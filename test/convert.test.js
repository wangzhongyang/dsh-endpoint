import test from 'node:test'
import assert from 'node:assert/strict'
import { firstUserText, systemText, toDshMessages, toDshTools } from '../src/openai/convert.js'
import { ApiError } from '../src/openai/errors.js'

const route = { provider: 'p', model: 'm' }
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function fakeImages() {
  const saved = []
  return {
    saved,
    saveImages: async (inputs) => {
      saved.push(...inputs)
      return inputs.map((input, index) => ({
        attachmentId: `att-${index}`,
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 1,
        height: 1,
        ...(input.name ? { name: input.name } : {}),
      }))
    },
  }
}

test('roles map onto DSH message shapes', async () => {
  const messages = await toDshMessages(
    [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ],
    route,
  )
  assert.deepEqual(
    messages.map((message) => message.role),
    ['system', 'user', 'assistant', 'tool'],
  )
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'be brief' }])
  assert.equal(messages[3].toolCallId, 'c1')
  assert.deepEqual(messages[3].source, { kind: 'tool', callId: 'c1' })
  assert.equal(messages[2].content[1].type, 'tool-call')
  assert.equal(messages[2].source.provider, 'p')
})

test('content parts are flattened to text blocks', async () => {
  const [message] = await toDshMessages(
    [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
    route,
  )
  assert.deepEqual(message.content, [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
  ])
})

test('inline image data URLs become image blocks through the attachment service', async () => {
  const images = fakeImages()
  const [message] = await toDshMessages(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看' },
          { type: 'image_url', image_url: { url: PNG } },
        ],
      },
    ],
    route,
    { saveImages: images.saveImages },
  )
  assert.equal(images.saved.length, 1)
  assert.equal(images.saved[0].mediaType, 'image/png')
  assert.equal(message.content[1].type, 'image')
  assert.equal(message.content[1].attachment.attachmentId, 'att-0')
})

test('remote image URLs are refused', async () => {
  await assert.rejects(
    () =>
      toDshMessages(
        [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }],
        route,
        { saveImages: fakeImages().saveImages },
      ),
    (error) => error instanceof ApiError && /remote file URLs/.test(error.message),
  )
})

test('images require the attachment service', async () => {
  await assert.rejects(
    () => toDshMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }], route),
    (error) => error instanceof ApiError && /not available in this profile/.test(error.message),
  )
})

test('inline text files are inlined as text', async () => {
  const data = Buffer.from('hello file', 'utf8').toString('base64')
  const [message] = await toDshMessages(
    [
      {
        role: 'user',
        content: [{ type: 'file', file: { filename: 'a.txt', file_data: `data:text/plain;base64,${data}` } }],
      },
    ],
    route,
    { saveImages: fakeImages().saveImages },
  )
  assert.equal(message.content[0].type, 'text')
  assert.match(message.content[0].text, /a\.txt/)
  assert.match(message.content[0].text, /hello file/)
})

test('binary documents are refused with guidance', async () => {
  const data = Buffer.from('%PDF-1.4', 'utf8').toString('base64')
  await assert.rejects(
    () =>
      toDshMessages(
        [
          {
            role: 'user',
            content: [
              { type: 'file', file: { filename: 'a.pdf', file_data: `data:application/pdf;base64,${data}` } },
            ],
          },
        ],
        route,
        { saveImages: fakeImages().saveImages },
      ),
    (error) => error instanceof ApiError && /unsupported inline media type/.test(error.message),
  )
})

test('file_id references are refused', async () => {
  await assert.rejects(
    () =>
      toDshMessages(
        [{ role: 'user', content: [{ type: 'file', file: { file_id: 'file-123' } }] }],
        route,
        { saveImages: fakeImages().saveImages },
      ),
    (error) => error instanceof ApiError && /file_id is not supported/.test(error.message),
  )
})

test('empty message lists are rejected', async () => {
  await assert.rejects(() => toDshMessages([], route), ApiError)
})

test('tool declarations map to DSH schemas', () => {
  assert.deepEqual(
    toDshTools([{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }]),
    [{ name: 'f', description: 'd', parameters: { type: 'object' } }],
  )
  assert.equal(toDshTools(undefined), undefined)
  assert.equal(toDshTools([]), undefined)
})

test('fingerprint inputs read the first user and all system text', () => {
  const messages = [
    { role: 'system', content: 's1' },
    { role: 'system', content: 's2' },
    { role: 'user', content: 'u1' },
    { role: 'user', content: 'u2' },
  ]
  assert.equal(systemText(messages), 's1\ns2')
  assert.equal(firstUserText(messages), 'u1')
})
