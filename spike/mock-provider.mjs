/**
 * Minimal OpenAI-compatible provider used only for local integration tests:
 * lets the endpoint be exercised end to end without any real credentials.
 *
 *   node spike/mock-provider.mjs [port]
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 44001)
const TEXT = process.env.MOCK_TEXT ?? 'hello from mock'

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url?.startsWith('/v1/chat/completions')) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const frame = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          created: 0,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      res.write(frame({ role: 'assistant', content: '' }))
      res.write(frame({ content: TEXT }))
      res.write(frame({}, 'stop'))
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          created: 0,
          model: body.model,
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        })}\n\n`,
      )
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: TEXT }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }),
    )
    return
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }] }))
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock provider on http://127.0.0.1:${port}/v1\n`)
})
