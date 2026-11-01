import test from 'node:test'
import assert from 'node:assert/strict'
import { CompletionCollector, StopMatcher, SseWriter, toFinishReason, toOpenAiUsage } from '../src/openai/stream.js'

test('usage maps onto OpenAI token details', () => {
  assert.deepEqual(
    toOpenAiUsage({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 90, cacheWriteTokens: 0, reasoningTokens: 2 }),
    {
      prompt_tokens: 100,
      completion_tokens: 4,
      total_tokens: 104,
      prompt_tokens_details: { cached_tokens: 90 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  )
  assert.equal(toOpenAiUsage(undefined), undefined)
})

test('finish reasons map onto the OpenAI vocabulary', () => {
  assert.equal(toFinishReason({ kind: 'stop' }), 'stop')
  assert.equal(toFinishReason({ kind: 'tool-calls' }), 'tool_calls')
  assert.equal(toFinishReason({ kind: 'max-tokens' }), 'length')
  assert.equal(toFinishReason({ kind: 'error', failure: { code: 'X' } }), 'stop')
})

test('the collector assembles text, reasoning and tool calls in block order', () => {
  const collector = new CompletionCollector()
  collector.push({ type: 'block-start', index: 0, blockType: 'reasoning' })
  collector.push({ type: 'reasoning-delta', index: 0, text: 'think' })
  collector.push({ type: 'block-start', index: 1, blockType: 'text' })
  collector.push({ type: 'text-delta', index: 1, text: 'hello' })
  collector.push({ type: 'block-start', index: 2, blockType: 'tool-call' })
  collector.push({ type: 'tool-call-delta', index: 2, id: 'c1', name: 'f', argumentsDelta: '{"a"' })
  collector.push({ type: 'tool-call-delta', index: 2, id: 'c1', argumentsDelta: ':1}' })
  assert.deepEqual(collector.blocks, [
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'hello' },
    { type: 'tool-call', id: 'c1', name: 'f', arguments: '{"a":1}' },
  ])
  assert.equal(collector.text, 'hello')
  assert.equal(collector.reasoning, 'think')
  assert.equal(collector.toolCalls.length, 1)
  assert.equal(collector.chunks.length, 7)
})

test('the SSE writer emits role, deltas, finish and [DONE]', () => {
  const written = []
  let ended = false
  const res = { write: (chunk) => written.push(chunk), end: () => (ended = true) }
  const writer = new SseWriter({ res, id: 'chatcmpl-1', created: 1, model: 'p/m' })
  writer.start()
  writer.chunk({ type: 'text-delta', index: 0, text: 'hi' })
  writer.chunk({ type: 'tool-call-delta', index: 2, id: 'c1', name: 'f', argumentsDelta: '{}' })
  writer.finish({ kind: 'tool-calls' })
  writer.usage({ inputTokens: 1, outputTokens: 2 })
  writer.end()

  const frames = written
    .map((chunk) => chunk.replace(/^data: /, '').replace(/\n\n$/, ''))
    .filter((line) => line !== '[DONE]')
    .map((line) => JSON.parse(line))
  assert.equal(frames[0].choices[0].delta.role, 'assistant')
  assert.equal(frames[1].choices[0].delta.content, 'hi')
  assert.deepEqual(frames[2].choices[0].delta.tool_calls[0].function, { name: 'f', arguments: '{}' })
  assert.equal(frames[3].choices[0].finish_reason, 'tool_calls')
  assert.equal(frames[4].usage.total_tokens, 3)
  assert.equal(written.at(-1), 'data: [DONE]\n\n')
  assert.equal(ended, true)
})

test('stop sequences cut text and report a hit', () => {
  const matcher = new StopMatcher(['STOP'])
  assert.deepEqual(matcher.push('hello '), { text: 'hel', hit: false })
  assert.deepEqual(matcher.push('STOP!'), { text: 'lo ', hit: true })
  assert.deepEqual(matcher.push('ignored'), { text: '', hit: true })
})

test('stop sequences flush held text when never hit', () => {
  const matcher = new StopMatcher(['END'])
  assert.deepEqual(matcher.push('abc'), { text: 'a', hit: false })
  assert.equal(matcher.flush(), 'bc')
})
