import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../src/config.js'
import { startEndpoint } from '../src/server.js'

function fakeLlm(onCall) {
  return {
    listProviders: () => [{ id: 'test' }],
    listModels: async (provider) => [{ provider, id: 'm1', name: 'M1', contextWindow: 1000 }],
    async *stream(options) {
      onCall?.(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'hello' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

async function withServer(llm, run, overrides = {}) {
  const config = Config({
    port: 0,
    defaultModel: 'test/m1',
    modelAliases: { 'gpt-4o': 'test/m1' },
    session: { mirror: false, ...(overrides.session ?? {}) },
    ...overrides,
  })
  const ctx = {
    get: (key) => (key === 'llm' ? llm : undefined),
    logger: { info() {}, warn() {}, error() {} },
  }
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-endpoint-test-'))
  const handle = await startEndpoint(ctx, config, { log: () => {}, stateRoot })
  try {
    await run(handle)
  } finally {
    await handle.dispose()
    await rm(stateRoot, { recursive: true, force: true })
  }
}

test('GET /healthz reports the package version', async () => {
  await withServer(fakeLlm(), async (handle) => {
    const body = await (await fetch(`${handle.url}/healthz`)).json()
    assert.match(body.version, /^\d+\.\d+\.\d+/)
    assert.deepEqual(body.providers, ['test'])
  })
})

test('GET /v1/models lists provider/model ids and aliases', async () => {
  await withServer(fakeLlm(), async (handle) => {
    const response = await fetch(`${handle.url}/v1/models`)
    assert.equal(response.status, 200)
    const body = await response.json()
    const ids = body.data.map((model) => model.id)
    assert.ok(ids.includes('test/m1'))
    assert.ok(ids.includes('gpt-4o'))
  })
})

test('chat completions forwards the request and returns the reply', async () => {
  let seen
  await withServer(fakeLlm((options) => (seen = options)), async (handle) => {
    const response = await fetch(`${handle.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 200)
    assert.ok(response.headers.get('x-dsh-session-id'))
    const body = await response.json()
    assert.equal(body.choices[0].message.content, 'hello')
    assert.equal(body.choices[0].finish_reason, 'stop')
    assert.equal(body.usage.prompt_tokens, 3)
    assert.match(seen.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(seen.provider, 'test')
    assert.equal(seen.model, 'm1')
    assert.deepEqual(seen.messages[0].content, [{ type: 'text', text: 'hi' }])
  })
})

test('streaming returns OpenAI chunks and terminates with [DONE]', async () => {
  await withServer(fakeLlm(), async (handle) => {
    const response = await fetch(`${handle.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test/m1', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const text = await response.text()
    assert.match(text, /"role":"assistant"/)
    assert.match(text, /"content":"hello"/)
    assert.match(text, /"finish_reason":"stop"/)
    assert.match(text, /data: \[DONE\]/)
  })
})

test('session id is stable for the same conversation and model', async () => {
  await withServer(fakeLlm(), async (handle) => {
    const request = () =>
      fetch(`${handle.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test/m1', messages: [{ role: 'user', content: 'stable?' }] }),
      })
    const first = await request()
    await first.text()
    const second = await request()
    await second.text()
    assert.equal(first.headers.get('x-dsh-session-id'), second.headers.get('x-dsh-session-id'))
  })
})

test('provider affinity id is stable for the same conversation', async () => {
  const seen = []
  await withServer(fakeLlm((options) => seen.push(options.sessionId)), async (handle) => {
    const request = () =>
      fetch(`${handle.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test/m1', messages: [{ role: 'user', content: 'affinity' }] }),
      })
    await (await request()).text()
    await (await request()).text()
    assert.equal(seen.length, 2)
    assert.equal(seen[0], seen[1])
  })
})

test('an explicit header is echoed back unchanged', async () => {
  await withServer(fakeLlm(), async (handle) => {
    const response = await fetch(`${handle.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-session-id': 'conv-42' },
      body: JSON.stringify({ model: 'test/m1', messages: [{ role: 'user', content: 'hi' }] }),
    })
    await response.text()
    assert.equal(response.headers.get('x-dsh-session-id'), 'conv-42')
  })
})

test('unknown models fail as model_not_found', async () => {
  await withServer(fakeLlm(), async (handle) => {
    const response = await fetch(`${handle.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope/missing', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 404)
    const body = await response.json()
    assert.equal(body.error.code, 'model_not_found')
  })
})

test('n > 1 is rejected explicitly', async () => {
  await withServer(fakeLlm(), async (handle) => {
    const response = await fetch(`${handle.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test/m1', n: 2, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.param, 'n')
  })
})
