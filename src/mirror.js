import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

/**
 * Mirrors endpoint conversations into real DSH sessions.
 *
 * A mirrored session is created through the public session store, given a
 * persistence write handle, and attached to a dedicated workspace, so it shows
 * up in the sidebar and can be read — but not continued — from the GUI. The
 * open write handle is also the single-writer lock that refuses `resume`.
 */
export class SessionMirror {
  /**
   * @param {object} ctx - Cordis host context
   * @param {object} options
   * @param {string} options.workspacePath - directory grouping mirrored sessions
   * @param {(level: string, message: string) => void} [options.log]
   */
  constructor(ctx, options) {
    this.ctx = ctx
    this.workspacePath = options.workspacePath
    this.log = options.log ?? (() => {})
    this.states = new Map()
    this.workspace = undefined
    this.workspacePromise = undefined
    this.closed = false
  }

  get available() {
    return (
      typeof this.ctx.get('sessions')?.create === 'function' &&
      typeof this.ctx.get('sessionPersistence')?.create === 'function'
    )
  }

  /**
   * Return the live mirror state for a stored mapping, restoring the session
   * from its log when the process no longer holds it.
   *
   * @param {{ dshSessionId: string, turns?: number }} entry
   */
  async ensure(entry) {
    const existing = this.states.get(entry.dshSessionId)
    if (existing !== undefined) return existing

    const { session, handle } = await this.#adopt(entry.dshSessionId)
    const state = {
      session,
      handle,
      turn: Number.isFinite(entry.turns) ? entry.turns : 0,
      step: 0,
      lastError: undefined,
    }
    this.states.set(entry.dshSessionId, state)
    await this.#attachWorkspace(entry.dshSessionId)
    return state
  }

  /**
   * Create a brand-new mirrored session owned by this plugin fiber.
   * @returns {Promise<{ dshSessionId: string, state: object }>}
   */
  async create() {
    const sessions = this.ctx.get('sessions')
    const persistence = this.ctx.get('sessionPersistence')
    // Mint the id ourselves: the store's counter restarts with the process, so
    // `sessions.create()` would hand out `session-1` again after a restart and
    // collide with an already persisted mirror.
    const session = sessions.create(`session-${randomUUID()}`, { meta: { cwd: this.workspacePath } })
    let handle
    try {
      handle = await persistence.create(session.header)
      // `sessions.create` publishes a few bookkeeping events (permission,
      // sandbox, approval) while announcing the session, before a write handle
      // exists — the live router only forwards what happens after `create`.
      // Persist that prefix explicitly so the routed batch starts at the right
      // cursor instead of failing contiguity.
      if (session.seq > 0) {
        const prefix = []
        for (let seq = 0; seq < session.seq; seq += 1) {
          const event = session.eventAt(seq)
          if (event !== undefined) prefix.push(event)
        }
        await handle.append(prefix)
      }
      // Materialize the header so `attachSession` can read the stored cwd.
      await handle.flush()
    } catch (error) {
      this.log('warn', `could not persist mirrored session ${session.id}: ${String(error)}`)
      throw error
    }
    const state = { session, handle, turn: 0, step: 0 }
    this.states.set(session.id, state)
    await this.#attachWorkspace(session.id)
    return { dshSessionId: session.id, state }
  }

  /**
   * Append the client-side part of one turn and open the turn for completion.
   *
   * @param {object} state - mirror state from `ensure`/`create`
   * @param {Array<object>} events - DSH surface events to append
   * @returns {{ turn: number, step: number }}
   */
  beginTurn(state, events) {
    state.turn += 1
    state.step = 1
    state.lastError = undefined
    const session = state.session
    session.append('turn/start', { turn: state.turn })
    session.append('step/start', { turn: state.turn, step: state.step })
    for (const event of events) {
      if (event.type === 'user/message') session.append('user/message', event.data, { surfaceOp: 'append' })
      else if (event.type === 'tool/result') {
        // `tool/result` is not the message itself: the event carries turn/step
        // and nests the ToolResultMessage under `message`.
        session.append(
          'tool/result',
          { turn: state.turn, step: state.step, message: event.message },
          { surfaceOp: 'append' },
        )
      } else throw new Error(`unsupported mirrored event ${event.type}`)
    }
    return { turn: state.turn, step: state.step }
  }

  /**
   * Close the open turn with a successful assistant message.
   *
   * @param {object} state
   * @param {object} result
   * @param {Array<object>} result.blocks - assembled assistant content blocks
   * @param {Array<object>} result.chunks - raw stream chunks, in order
   * @param {object} [result.usage]
   * @param {string} result.provider
   * @param {string} result.model
   */
  completeTurn(state, { blocks, chunks, usage, provider, model }) {
    const session = state.session
    const message = {
      id: randomUUID(),
      role: 'assistant',
      content: blocks,
      source: { kind: 'model', provider, model },
    }
    session.append(
      'assistant/message',
      {
        turn: state.turn,
        step: state.step,
        message,
        stream: chunks.map((chunk) => ({ type: 'chunk', time: Date.now(), chunk: sanitize(chunk) })),
        ...(usage === undefined ? {} : { usage: sanitize(usage) }),
      },
      { surfaceOp: 'append' },
    )
    session.append('step/end', { turn: state.turn, step: state.step })
    session.append('turn/end', { turn: state.turn, reason: { kind: 'completed' } })
  }

  /**
   * Close the open turn without an assistant message.
   *
   * @param {object} state
   * @param {{ message: string, code: string }} failure
   */
  failTurn(state, failure) {
    const session = state.session
    state.lastError = failure
    session.append('step/end', { turn: state.turn, step: state.step })
    session.append('turn/end', {
      turn: state.turn,
      reason: { kind: 'error', error: { message: failure.message, code: failure.code } },
    })
  }

  /** Best-effort durability barrier for one mirrored session. */
  async flush(state) {
    try {
      await this.ctx.get('sessions').flush(state.session)
    } catch (error) {
      this.log('warn', `flush failed for ${state.session.id}: ${String(error)}`)
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const state of this.states.values()) {
      await this.flush(state)
      await state.handle?.close?.().catch((error) => this.log('warn', `handle close failed: ${String(error)}`))
    }
    this.states.clear()
  }

  async #adopt(id) {
    const sessions = this.ctx.get('sessions')
    const live = sessions.get(id)
    if (live !== undefined) {
      // Same-process reload: the session is still live, only the handle is ours.
      const handle = await this.ctx.get('sessionPersistence').open(id, 'write')
      return { session: live, handle }
    }
    const persistence = this.ctx.get('sessionPersistence')
    const handle = await persistence.open(id, 'write')
    try {
      const read = await handle.read(0)
      const session = sessions.prepare(id, {
        seed: read.events,
        meta: handle.header,
        inheritedEventCount: handle.inheritedEventCount,
        eventState: read.eventState,
      })
      sessions.enter(session)
      sessions.announce(session)
      return { session, handle }
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  async #attachWorkspace(sessionId) {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return
    try {
      this.workspacePromise ??= (async () => {
        await mkdir(this.workspacePath, { recursive: true })
        return registry.create(this.workspacePath)
      })()
      this.workspace = await this.workspacePromise
      await this.workspace?.attachSession(sessionId)
    } catch (error) {
      this.workspacePromise = undefined
      this.workspace = undefined
      this.log('warn', `could not attach ${sessionId} to workspace ${this.workspacePath}: ${String(error)}`)
    }
  }
}

/** Strip undefined/function values that the session log refuses to snapshot. */
function sanitize(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * Build a DSH `user/message` surface event payload.
 * @param {string} text
 */
export function userMessageEvent(textOrBlocks) {
  const content =
    typeof textOrBlocks === 'string'
      ? textOrBlocks.length > 0
        ? [{ type: 'text', text: textOrBlocks }]
        : [{ type: 'text', text: '[empty]' }]
      : Array.isArray(textOrBlocks) && textOrBlocks.length > 0
        ? textOrBlocks
        : [{ type: 'text', text: '[empty]' }]
  return {
    type: 'user/message',
    data: {
      id: randomUUID(),
      role: 'user',
      content,
      source: { kind: 'user' },
    },
  }
}

/**
 * Build a DSH `tool/result` surface event payload.
 * @param {object} input
 */
export function toolResultEvent({ callId, text, isError = false }) {
  return {
    type: 'tool/result',
    message: {
      id: randomUUID(),
      role: 'tool',
      toolCallId: callId,
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId },
      ...(isError ? { isError: true } : {}),
    },
  }
}
