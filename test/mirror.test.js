import test from 'node:test'
import assert from 'node:assert/strict'
import { toolResultEvent, userMessageEvent } from '../src/mirror.js'

test('user messages carry the message inline', () => {
  const event = userMessageEvent('hi')
  assert.equal(event.type, 'user/message')
  assert.equal(event.data.role, 'user')
  assert.deepEqual(event.data.content, [{ type: 'text', text: 'hi' }])
  assert.equal(event.data.source.kind, 'user')
})

test('user messages keep media blocks by reference', () => {
  const blocks = [
    { type: 'text', text: 'look' },
    { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 } },
  ]
  const event = userMessageEvent(blocks)
  assert.equal(event.data.content.length, 2)
  assert.equal(event.data.content[1].type, 'image')
  assert.equal(event.data.content[1].attachment.attachmentId, 'att-1')
})

test('empty user content still yields a valid message', () => {
  const event = userMessageEvent('')
  assert.deepEqual(event.data.content, [{ type: 'text', text: '[empty]' }])
})

test('tool results nest the message under `message`', () => {
  const event = toolResultEvent({ callId: 'c1', text: 'ok', isError: false })
  assert.equal(event.type, 'tool/result')
  assert.equal(event.data, undefined)
  assert.equal(event.message.role, 'tool')
  assert.equal(event.message.toolCallId, 'c1')
  assert.deepEqual(event.message.source, { kind: 'tool', callId: 'c1' })
  assert.equal(event.message.isError, undefined)
})

test('failed tool results are marked', () => {
  const event = toolResultEvent({ callId: 'c2', text: 'boom', isError: true })
  assert.equal(event.message.isError, true)
})
