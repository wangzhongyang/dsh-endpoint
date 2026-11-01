import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

const STATE_VERSION = 1

/**
 * Durable `external conversation key -> DSH session` mapping.
 *
 * The process holds an exclusive lock file so two DSH instances cannot drive
 * the same mirrored sessions (a persisted session has one writer).
 */
export class MappingStore {
  /**
   * @param {string} file - absolute path of the JSON state file
   * @param {{ log?: (level: string, message: string) => void }} [options]
   */
  constructor(file, options = {}) {
    this.file = file
    this.lockFile = `${file}.lock`
    this.log = options.log ?? (() => {})
    this.entries = new Map()
    this.lock = undefined
    this.writeChain = Promise.resolve()
    this.dirty = false
    this.closed = false
  }

  async open() {
    await mkdir(dirname(this.file), { recursive: true })
    await this.#acquireLock()
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed?.version !== STATE_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) {
        throw new Error(`unrecognised state file version in ${this.file}`)
      }
      for (const [hash, entry] of Object.entries(parsed.entries)) {
        if (typeof entry?.dshSessionId !== 'string' || entry.dshSessionId.length === 0) continue
        this.entries.set(hash, normaliseEntry(hash, entry))
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        await this.#releaseLock()
        throw error
      }
    }
  }

  get(hash) {
    return this.entries.get(hash)
  }

  list() {
    return [...this.entries.values()]
  }

  async bind(hash, entry) {
    const now = Date.now()
    const next = normaliseEntry(hash, {
      requests: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      userHashes: [],
      createdAt: now,
      ...entry,
      lastUsedAt: now,
    })
    this.entries.set(hash, next)
    await this.save()
    return next
  }

  async update(hash, patch) {
    const current = this.entries.get(hash)
    if (current === undefined) return undefined
    const next = normaliseEntry(hash, { ...current, ...patch, lastUsedAt: Date.now() })
    this.entries.set(hash, next)
    await this.save()
    return next
  }

  async remove(hash) {
    if (this.entries.delete(hash)) await this.save()
  }

  /**
   * Drop mappings idle for longer than `ttlDays` and return them so the caller
   * can archive their sessions. A TTL of 0 disables expiry.
   *
   * @param {number} ttlDays
   * @returns {Promise<Array<object>>}
   */
  async expire(ttlDays) {
    if (!(ttlDays > 0)) return []
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000
    const expired = []
    for (const [hash, entry] of this.entries) {
      if (entry.lastUsedAt <= cutoff) {
        this.entries.delete(hash)
        expired.push(entry)
      }
    }
    if (expired.length > 0) await this.save()
    return expired
  }

  async save() {
    if (this.closed) return
    this.dirty = true
    this.writeChain = this.writeChain.then(async () => {
      if (!this.dirty) return
      this.dirty = false
      const payload = JSON.stringify(
        { version: STATE_VERSION, entries: Object.fromEntries(this.entries) },
        null,
        2,
      )
      const tmp = `${this.file}.tmp`
      await mkdir(dirname(this.file), { recursive: true })
      const handle = await open(tmp, 'w')
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tmp, this.file)
    })
    return this.writeChain
  }

  async close() {
    if (this.closed) return
    await this.save().catch((error) => this.log('warn', `state save failed: ${String(error)}`))
    this.closed = true
    await this.#releaseLock()
  }

  async #acquireLock() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.lock = await open(this.lockFile, 'wx')
        await this.lock.writeFile(`${process.pid}\n${Date.now()}\n`, 'utf8')
        return
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const owner = await readLockOwner(this.lockFile)
        if (owner !== undefined && owner !== process.pid && isAlive(owner)) {
          throw new Error(
            `another dsh-endpoint instance (pid ${owner}) already owns ${this.file}; ` +
              'two instances cannot drive the same mirrored sessions',
          )
        }
        await unlink(this.lockFile).catch(() => {})
      }
    }
    throw new Error(`could not acquire ${this.lockFile}`)
  }

  async #releaseLock() {
    const lock = this.lock
    this.lock = undefined
    if (lock !== undefined) await lock.close().catch(() => {})
    await unlink(this.lockFile).catch(() => {})
  }
}

function normaliseEntry(hash, entry) {
  const now = Date.now()
  return {
    keyHash: hash,
    externalKey: typeof entry.externalKey === 'string' ? entry.externalKey : '',
    source: typeof entry.source === 'string' ? entry.source : 'unknown',
    dshSessionId: String(entry.dshSessionId),
    workspacePath: typeof entry.workspacePath === 'string' ? entry.workspacePath : '',
    model: typeof entry.model === 'string' ? entry.model : '',
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : now,
    lastUsedAt: Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : now,
    requests: toCount(entry.requests),
    turns: toCount(entry.turns),
    inputTokens: toCount(entry.inputTokens),
    outputTokens: toCount(entry.outputTokens),
    userHashes: Array.isArray(entry.userHashes) ? entry.userHashes.filter((h) => typeof h === 'string') : [],
  }
}

function toCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

async function readLockOwner(lockFile) {
  try {
    const raw = await readFile(lockFile, 'utf8')
    const pid = Number.parseInt(raw.split('\n')[0] ?? '', 10)
    return Number.isFinite(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}
