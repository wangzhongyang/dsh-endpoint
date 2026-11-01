import { Config } from './config.js'
import { startEndpoint } from './server.js'

export const name = 'dsh-endpoint'

/** `ctx.llm` is the only hard dependency: every provider call goes through it. */
export const inject = ['llm']

export { Config }

/**
 * @param {object} ctx - Cordis host context
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const resolved = config ?? Config({})
  const log = (level, message) => {
    const logger = ctx.logger
    if (typeof logger?.[level] === 'function') logger[level](`[dsh-endpoint] ${message}`)
    else if (level === 'warn') console.warn(`[dsh-endpoint] ${message}`)
    else console.log(`[dsh-endpoint] ${message}`)
  }

  ctx.effect(async () => {
    const handle = await startEndpoint(ctx, resolved, { log })
    return handle.dispose
  })
}
