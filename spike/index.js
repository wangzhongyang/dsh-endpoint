/**
 * P0 spike: prove that a plugin can create a real, persisted, sidebar-visible
 * DSH session, append a canonical turn, read it back, and block GUI takeover.
 *
 * Run it with a throwaway DSH_HOME (see `spike/run.sh`); it prints one
 * `SPIKE_RESULT {...}` line and exits.
 */
import { SessionMirror, userMessageEvent } from '../src/mirror.js'

export const name = 'dsh-endpoint-spike'

export function apply(ctx) {
  ctx.effect(() => {
    const timer = setTimeout(() => {
      run(ctx)
        .then((result) => {
          process.stdout.write(`SPIKE_RESULT ${JSON.stringify(result)}\n`)
          process.exit(0)
        })
        .catch((error) => {
          process.stdout.write(`SPIKE_ERROR ${JSON.stringify({ message: String(error), stack: error?.stack })}\n`)
          process.exit(1)
        })
    }, 0)
    return () => clearTimeout(timer)
  })
}

async function run(ctx) {
  const result = { steps: {} }
  await ctx.get('loader')?.await?.()

  const workspacePath = process.env.DSH_ENDPOINT_SPIKE_WORKSPACE
  const log = (level, message) => process.stderr.write(`SPIKE_LOG ${level} ${message}\n`)
  result.steps.workspacePath = workspacePath
  result.steps.services = ['sessions', 'sessionPersistence', 'sessionQuery', 'workspaceRegistry'].filter(
    (key) => ctx.get(key) !== undefined,
  )

  const mirror = new SessionMirror(ctx, { workspacePath, log })
  const created = await mirror.create()
  result.steps.sessionId = created.dshSessionId

  const seen = []
  const off = ctx.on('session/event', (session, event) => {
    if (session.id === created.dshSessionId) seen.push(event.seq)
  })
  result.steps.seqAfterCreate = created.state.session.seq

  const fail = (step, error) => {
    result.steps[step] = { error: String(error?.message ?? error) }
  }

  try {
    mirror.beginTurn(created.state, [userMessageEvent('spike: user turn one')])
    result.steps.seqAfterBegin = created.state.session.seq
    mirror.completeTurn(created.state, {
      blocks: [{ type: 'text', text: 'spike: assistant reply one' }],
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'spike: assistant reply one' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'spike: assistant reply one' } },
        { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
      provider: 'spike',
      model: 'spike-1',
    })
    result.steps.seqAfterComplete = created.state.session.seq
    await mirror.flush(created.state)
  } catch (error) {
    fail('firstTurn', error)
  }
  result.steps.seenSeqs = seen
  result.steps.eventsAfterFirstTurn = await readEventTypes(ctx, created.dshSessionId)

  // Takeover must be refused while the write handle is open.
  const agentLoop = ctx.get('agentLoop')
  if (agentLoop !== undefined) {
    try {
      const handle = await agentLoop.resume(ctx, { resumeSessionId: created.dshSessionId })
      result.steps.takeover = { refused: false, resumed: handle !== undefined }
      await handle?.dispose?.().catch?.(() => {})
    } catch (error) {
      result.steps.takeover = { refused: true, message: String(error?.message ?? error) }
    }
  } else {
    result.steps.takeover = { skipped: 'no agentLoop' }
  }

  // Restore from storage on a fresh mirror and append a second turn.
  await mirror.close()
  off?.()
  try {
    const restored = new SessionMirror(ctx, { workspacePath, log })
    const state = await restored.ensure({ dshSessionId: created.dshSessionId, turns: 1 })
    result.steps.restored = state.session.id === created.dshSessionId
    restored.beginTurn(state, [userMessageEvent('spike: user turn two')])
    restored.completeTurn(state, {
      blocks: [{ type: 'text', text: 'spike: assistant reply two' }],
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'spike: assistant reply two' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'spike: assistant reply two' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      provider: 'spike',
      model: 'spike-1',
    })
    await restored.flush(state)
    result.steps.eventsAfterSecondTurn = await readEventTypes(ctx, created.dshSessionId)
    await restored.close()
  } catch (error) {
    fail('restore', error)
  }

  const { realpath } = await import('node:fs/promises')
  const realPath = await realpath(workspacePath).catch(() => workspacePath)
  const workspaces = ctx.get('workspaceRegistry')?.list?.() ?? []
  result.steps.workspacePaths = workspaces.map((w) => w.path)
  const workspace = workspaces.find((w) => w.path === realPath || w.path === workspacePath)
  result.steps.attachedToWorkspace = workspace?.sessionIds?.includes(created.dshSessionId) ?? false
  result.steps.workspaceTitle = workspace?.title
  return result
}

async function readEventTypes(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return 'no sessionQuery'
  try {
    const events = await query.listEvents(sessionId)
    return events.map((event) => event.type)
  } catch (error) {
    return `error: ${String(error?.message ?? error)}`
  }
}
