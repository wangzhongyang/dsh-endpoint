import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveSessionKey,
  resolveExternalKey,
  sessionKeyHash,
} from '../src/session/key.js'

const base = { headers: {}, body: {} }

test('the endpoint own header has top precedence', () => {
  const found = resolveExternalKey({
    ...base,
    headers: { 'x-dsh-session-id': 'own', 'x-session-id': 'other' },
  })
  assert.deepEqual(found, { key: 'own', source: 'header:x-dsh-session-id' })
})

test('known agent headers are honoured case-insensitively', () => {
  const found = resolveExternalKey({
    ...base,
    headers: { 'X-Claude-Code-Session-Id': 'abc' },
  })
  assert.deepEqual(found, { key: 'abc', source: 'header:x-claude-code-session-id' })
})

test('body identifiers and the OpenAI user field are probed in order', () => {
  assert.deepEqual(resolveExternalKey({ ...base, body: { conversation_id: 'c1' } }), {
    key: 'c1',
    source: 'body:conversation_id',
  })
  assert.deepEqual(resolveExternalKey({ ...base, body: { metadata: { session_id: 'm1' } } }), {
    key: 'm1',
    source: 'body:metadata.session_id',
  })
  assert.deepEqual(resolveExternalKey({ ...base, body: { user: 'u1' } }), { key: 'u1', source: 'body:user' })
})

test('per-request trace headers never become a conversation key', () => {
  assert.equal(resolveExternalKey({ ...base, headers: { 'x-request-id': 'r1', 'x-trace-id': 't1' } }), undefined)
})

test('derived keys are deterministic and restart-stable', () => {
  const args = { model: 'p/m', firstUserText: 'hello there', deriveFrom: ['model', 'first-user'] }
  const first = deriveSessionKey(args)
  const second = deriveSessionKey(args)
  assert.deepEqual(first, second)
  assert.equal(first.source, 'derived')
  assert.match(first.key, /^auto:[0-9a-f]{32}$/)
})

test('derived keys separate models, and system text only when configured', () => {
  const a = deriveSessionKey({ model: 'p/m1', firstUserText: 'x', systemText: 's1', deriveFrom: ['model', 'first-user'] })
  const b = deriveSessionKey({ model: 'p/m2', firstUserText: 'x', systemText: 's1', deriveFrom: ['model', 'first-user'] })
  assert.notEqual(a.key, b.key)

  const withSystemA = deriveSessionKey({ model: 'p/m1', firstUserText: 'x', systemText: 's1', deriveFrom: ['system'] })
  const withSystemB = deriveSessionKey({ model: 'p/m1', firstUserText: 'x', systemText: 's2', deriveFrom: ['system'] })
  assert.notEqual(withSystemA.key, withSystemB.key)
})

test('mapping hashes are opaque and collision-free for long identities', () => {
  const long = 'x'.repeat(500)
  assert.equal(sessionKeyHash(long).length, 32)
  assert.equal(sessionKeyHash(long), sessionKeyHash(long))
  assert.notEqual(sessionKeyHash('a'), sessionKeyHash('b'))
})
