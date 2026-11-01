import { randomUUID } from 'node:crypto'

export function newCompletionId() {
  return `chatcmpl-${randomUUID().replaceAll('-', '')}`
}

/** Map a DSH `usage` chunk to an OpenAI usage object. */
export function toOpenAiUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const input = number(usage.inputTokens)
  const output = number(usage.outputTokens)
  const cacheRead = number(usage.cacheReadTokens)
  const cacheWrite = number(usage.cacheWriteTokens)
  const reasoning = number(usage.reasoningTokens)
  return {
    prompt_tokens: input + cacheRead + cacheWrite,
    completion_tokens: output,
    total_tokens: input + cacheRead + cacheWrite + output,
    prompt_tokens_details: { cached_tokens: cacheRead },
    completion_tokens_details: { reasoning_tokens: reasoning },
  }
}

function number(value) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** Map a DSH finish reason to an OpenAI `finish_reason`. */
export function toFinishReason(reason) {
  switch (reason?.kind) {
    case 'stop':
      return 'stop'
    case 'tool-calls':
      return 'tool_calls'
    case 'max-tokens':
      return 'length'
    case 'aborted':
      return 'stop'
    case 'error':
      return 'stop'
    default:
      return 'stop'
  }
}

/**
 * Assembles raw DSH chunks into the assistant content blocks the session log
 * expects, while feeding the SSE writer.
 */
export class CompletionCollector {
  constructor() {
    this.chunks = []
    this.partials = new Map()
    this.text = ''
    this.reasoning = ''
    this.usage = undefined
    this.finishReason = undefined
    this.failure = undefined
  }

  push(chunk) {
    this.chunks.push(chunk)
    switch (chunk?.type) {
      case 'block-start': {
        this.#ensure(chunk.index, chunk.blockType)
        return
      }
      case 'text-delta': {
        const partial = this.#ensure(chunk.index, 'text')
        partial.text += chunk.text
        this.text += chunk.text
        return
      }
      case 'reasoning-delta': {
        const partial = this.#ensure(chunk.index, 'reasoning')
        partial.text += chunk.text
        this.reasoning += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.#ensure(chunk.index, 'tool-call')
        if (typeof chunk.id === 'string' && chunk.id.length > 0) partial.id = chunk.id
        if (typeof chunk.name === 'string' && chunk.name.length > 0) partial.name = chunk.name
        partial.arguments += chunk.argumentsDelta ?? ''
        return
      }
      case 'block-end': {
        const partial = this.#ensure(chunk.index, chunk.block?.type ?? 'text')
        partial.closed = chunk.block
        return
      }
      case 'usage': {
        this.usage = chunk.usage
        return
      }
      case 'finish': {
        this.finishReason = chunk.reason
        if (chunk.reason?.kind === 'error') this.failure = chunk.reason.failure
        return
      }
      default:
        return
    }
  }

  get blocks() {
    const blocks = []
    for (const [, partial] of [...this.partials].sort((a, b) => a[0] - b[0])) {
      if (partial.closed !== undefined) {
        blocks.push(partial.closed)
        continue
      }
      if (partial.type === 'text' && partial.text.length > 0) blocks.push({ type: 'text', text: partial.text })
      else if (partial.type === 'reasoning' && partial.text.length > 0) {
        blocks.push({ type: 'reasoning', text: partial.text })
      } else if (partial.type === 'tool-call') {
        blocks.push({
          type: 'tool-call',
          id: partial.id ?? randomUUID(),
          name: partial.name ?? '',
          arguments: partial.arguments,
        })
      }
    }
    return blocks
  }

  get toolCalls() {
    return this.blocks.filter((block) => block.type === 'tool-call')
  }

  #ensure(index, type) {
    let partial = this.partials.get(index)
    if (partial === undefined) {
      partial = { type, text: '', arguments: '', id: undefined, name: undefined, closed: undefined }
      this.partials.set(index, partial)
    }
    return partial
  }
}

/**
 * Incremental OpenAI SSE writer for one completion.
 *
 * DSH block indexes are not OpenAI tool indexes (text and reasoning blocks are
 * interleaved), so tool calls get their own 0-based counter.
 */
export class SseWriter {
  constructor({ res, id, created, model }) {
    this.res = res
    this.id = id
    this.created = created
    this.model = model
    this.toolIndex = new Map()
    this.nextToolIndex = 0
    this.done = false
  }

  #write(payload) {
    if (this.done) return
    this.res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  #frame(delta, finishReason = null) {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }
  }

  start() {
    this.#write(this.#frame({ role: 'assistant', content: '' }))
  }

  /** @param {object} chunk */
  chunk(chunk) {
    switch (chunk?.type) {
      case 'text-delta':
        if (chunk.text.length > 0) this.#write(this.#frame({ content: chunk.text }))
        return
      case 'reasoning-delta':
        if (chunk.text.length > 0) this.#write(this.#frame({ reasoning_content: chunk.text }))
        return
      case 'tool-call-delta': {
        let index = this.toolIndex.get(chunk.index)
        const first = index === undefined
        if (first) {
          index = this.nextToolIndex
          this.nextToolIndex += 1
          this.toolIndex.set(chunk.index, index)
        }
        this.#write(
          this.#frame({
            tool_calls: [
              {
                index,
                ...(first ? { id: chunk.id, type: 'function' } : {}),
                function: {
                  ...(first && typeof chunk.name === 'string' ? { name: chunk.name } : {}),
                  arguments: chunk.argumentsDelta ?? '',
                },
              },
            ],
          }),
        )
        return
      }
      default:
        return
    }
  }

  finish(reason) {
    this.#write(this.#frame({}, toFinishReason(reason)))
  }

  /** Emit an error frame on an already-started stream. */
  writeError(body) {
    this.#write(body)
  }

  usage(usage) {
    const mapped = toOpenAiUsage(usage)
    if (mapped === undefined) return
    this.#write({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [],
      usage: mapped,
    })
  }

  end() {
    if (this.done) return
    this.done = true
    this.res.write('data: [DONE]\n\n')
    this.res.end()
  }
}

/**
 * Tracks OpenAI `stop` sequences across delta boundaries and reports where the
 * visible text must be cut. DSH adapters do not all accept `stop`, so the
 * endpoint honours it itself.
 */
export class StopMatcher {
  /** @param {string[]} sequences */
  constructor(sequences) {
    this.sequences = sequences.filter((value) => typeof value === 'string' && value.length > 0)
    this.seen = ''
    this.hit = false
  }

  get active() {
    return this.sequences.length > 0
  }

  /**
   * @param {string} delta
   * @returns {{ text: string, hit: boolean }}
   */
  push(delta) {
    if (!this.active || this.hit) return { text: '', hit: this.hit }
    this.seen += delta
    let cut = this.seen.length
    for (const sequence of this.sequences) {
      const index = this.seen.indexOf(sequence)
      if (index >= 0 && index < cut) cut = index
    }
    if (cut < this.seen.length) {
      this.hit = true
      const text = this.seen.slice(0, cut)
      return { text, hit: true }
    }
    // Emit everything that can no longer be part of a stop sequence.
    const held = this.sequences.reduce((max, sequence) => Math.max(max, sequence.length), 1) - 1
    if (this.seen.length <= held) return { text: '', hit: false }
    const text = this.seen.slice(0, this.seen.length - held)
    this.seen = this.seen.slice(this.seen.length - held)
    return { text, hit: false }
  }

  /** Remaining text when the stream ends without a stop hit. */
  flush() {
    const text = this.seen
    this.seen = ''
    return text
  }
}
