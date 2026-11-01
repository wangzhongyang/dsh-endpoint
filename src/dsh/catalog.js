import { notFound, badRequest } from '../openai/errors.js'

const CACHE_TTL_MS = 60_000

/**
 * Reads the live provider/model directory from `ctx.llm` and resolves the
 * `model` string of an OpenAI request to a concrete `provider/model` route.
 */
export class ModelCatalog {
  /**
   * @param {{ listProviders: Function, listModels: Function }} llm
   * @param {{ aliases?: Record<string,string>, defaultModel?: string, log?: Function }} [options]
   */
  constructor(llm, options = {}) {
    this.llm = llm
    this.aliases = options.aliases ?? {}
    this.defaultModel = options.defaultModel ?? ''
    this.log = options.log ?? (() => {})
    this.cache = new Map()
    this.created = Math.floor(Date.now() / 1000)
  }

  /** @returns {Array<{id:string}>} */
  providers() {
    try {
      const listed = this.llm.listProviders()
      return Array.isArray(listed) ? listed.filter((entry) => typeof entry?.id === 'string') : []
    } catch (error) {
      this.log('warn', `listProviders failed: ${String(error)}`)
      return []
    }
  }

  async modelsOf(provider) {
    const cached = this.cache.get(provider)
    const now = Date.now()
    if (cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.models
    try {
      const models = await this.llm.listModels(provider)
      const safe = Array.isArray(models) ? models : []
      this.cache.set(provider, { at: now, models: safe })
      return safe
    } catch (error) {
      this.log('warn', `listModels(${provider}) failed: ${String(error)}`)
      this.cache.set(provider, { at: now, models: cached?.models ?? [] })
      return cached?.models ?? []
    }
  }

  /** OpenAI `/v1/models` payload. */
  async list() {
    const data = []
    const seen = new Set()
    for (const provider of this.providers()) {
      const models = await this.modelsOf(provider.id)
      for (const model of models) {
        const id = `${provider.id}/${model.id}`
        if (seen.has(id)) continue
        seen.add(id)
        data.push({
          id,
          object: 'model',
          created: this.created,
          owned_by: provider.id,
          ...(typeof model.name === 'string' ? { name: model.name } : {}),
        })
      }
    }
    for (const [alias, target] of Object.entries(this.aliases)) {
      if (seen.has(alias)) continue
      data.push({ id: alias, object: 'model', created: this.created, owned_by: target.split('/')[0] ?? 'dsh-endpoint' })
    }
    return data
  }

  /**
   * Resolve a requested model name to a concrete route.
   * @param {unknown} requested
   * @returns {{ provider: string, model: string, id: string }}
   */
  resolve(requested) {
    const name = typeof requested === 'string' && requested.length > 0 ? requested : this.defaultModel
    if (typeof name !== 'string' || name.length === 0) {
      throw badRequest('`model` is required (use `provider/model` or a configured alias)', 'model')
    }
    const aliased = this.aliases[name] ?? name
    const slash = aliased.indexOf('/')
    if (slash <= 0 || slash === aliased.length - 1) {
      throw notFound(`model "${name}" is not a provider/model route; configure modelAliases or use provider/model`)
    }
    const provider = aliased.slice(0, slash)
    const model = aliased.slice(slash + 1)
    const known = this.providers().some((entry) => entry.id === provider)
    if (!known) throw notFound(`provider "${provider}" is not configured in this DSH instance`)
    return { provider, model, id: aliased }
  }
}
