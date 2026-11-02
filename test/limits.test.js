import test from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/config.js'
import { DSH_MAX_REQUEST_BODY_BYTES, clampLimits } from '../src/limits.js'

test('the schema refuses a body cap above DSH default', () => {
  assert.throws(() => Config({ limits: { maxBodyBytes: DSH_MAX_REQUEST_BODY_BYTES + 1 } }))
  assert.equal(Config({ limits: { maxBodyBytes: DSH_MAX_REQUEST_BODY_BYTES } }).limits.maxBodyBytes, DSH_MAX_REQUEST_BODY_BYTES)
})

test('clampLimits caps the body at the DSH default', () => {
  const warnings = []
  const out = clampLimits(
    { maxBodyBytes: DSH_MAX_REQUEST_BODY_BYTES * 2, maxTextFileBytes: 1024 },
    (level, message) => warnings.push(`${level}:${message}`),
  )
  assert.equal(out.maxBodyBytes, DSH_MAX_REQUEST_BODY_BYTES)
  assert.equal(out.maxTextFileBytes, 1024)
  assert.equal(warnings.length, 1)
})

test('clampLimits keeps the text cap under the body cap', () => {
  const out = clampLimits({ maxBodyBytes: 20 * 1024 * 1024, maxTextFileBytes: 50 * 1024 * 1024 })
  assert.equal(out.maxTextFileBytes, 20 * 1024 * 1024)
})

test('defaults are 20 MiB body and 8 MiB text', () => {
  const config = Config({})
  assert.equal(config.limits.maxBodyBytes, 20 * 1024 * 1024)
  assert.equal(config.limits.maxTextFileBytes, 8 * 1024 * 1024)
})
