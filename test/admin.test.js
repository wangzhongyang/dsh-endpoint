import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeConfig, normalisePatch } from '../src/admin.js'

const base = {
  host: '127.0.0.1',
  port: 43130,
  defaultModel: 'p/m',
  modelAliases: { a: 'p/m' },
  session: { mirror: true, mappingTtlDays: 3, workspacePath: '' },
  limits: { maxBodyBytes: 100 },
  log: { accessFile: '' },
}

test('overlay wins over the entry config, nested objects merge', () => {
  const merged = mergeConfig(base, {
    port: 44000,
    session: { mappingTtlDays: 7 },
    unknownKey: 'ignored',
  })
  assert.equal(merged.port, 44000)
  assert.equal(merged.session.mappingTtlDays, 7)
  assert.equal(merged.session.mirror, true)
  assert.equal(Object.hasOwn(merged, 'unknownKey'), false)
})

test('host/port changes rebind the listener instead of needing a restart', () => {
  const same = normalisePatch({ host: '127.0.0.1', port: 43130 }, base)
  assert.equal(same.restartRequired, false)
  assert.equal(same.rebind, false)

  assert.deepEqual(
    [normalisePatch({ host: '0.0.0.0' }, base).rebind, normalisePatch({ host: '0.0.0.0' }, base).restartRequired],
    [true, false],
  )
  assert.deepEqual(
    [normalisePatch({ port: 44000 }, base).rebind, normalisePatch({ port: 44000 }, base).restartRequired],
    [true, false],
  )
})

test('mirror and workspace changes still require a plugin reload', () => {
  const mirror = normalisePatch({ session: { mirror: false } }, base)
  assert.equal(mirror.restartRequired, true)
  assert.equal(mirror.rebind, false)

  const workspace = normalisePatch({ session: { workspacePath: '/tmp/x' } }, base)
  assert.equal(workspace.restartRequired, true)
  assert.equal(workspace.rebind, false)
})

test('runtime fields do not require a restart', () => {
  assert.equal(normalisePatch({ defaultModel: 'q/n' }, base).restartRequired, false)
  assert.equal(normalisePatch({ modelAliases: { b: 'q/n' } }, base).restartRequired, false)
  assert.equal(normalisePatch({ session: { mappingTtlDays: 1 } }, base).restartRequired, false)
})

test('limits are accepted and bounded by DSH', () => {
  const ok = normalisePatch({ limits: { maxBodyBytes: 20 * 1024 * 1024, maxTextFileBytes: 8 * 1024 * 1024 } }, base)
  assert.deepEqual(ok.patch.limits, { maxBodyBytes: 20 * 1024 * 1024, maxTextFileBytes: 8 * 1024 * 1024 })
  assert.equal(ok.restartRequired, false)

  assert.throws(() => normalisePatch({ limits: { maxBodyBytes: 301 * 1024 * 1024 } }, base), /cannot exceed DSH/)
  assert.throws(
    () => normalisePatch({ limits: { maxBodyBytes: 1024 * 1024, maxTextFileBytes: 2 * 1024 * 1024 } }, base),
    /cannot exceed limits.maxBodyBytes/,
  )
  assert.throws(() => normalisePatch({ limits: { maxBodyBytes: 1.5 } }, base), /positive integer/)
})

test('invalid values are rejected', () => {
  assert.throws(() => normalisePatch({ port: 70000 }, base), /port/)
  assert.throws(() => normalisePatch({ modelAliases: { x: 'no-slash' } }, base), /provider\/model/)
  assert.throws(() => normalisePatch({ session: { mirror: 'yes' } }, base), /mirror/)
  assert.throws(() => normalisePatch({ session: { mappingTtlDays: -1 } }, base), /mappingTtlDays/)
})
