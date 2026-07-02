import { describe, expect, it } from 'vitest'
import type { DbConnectionSummary } from '../../../../shared/database-types'
import { buildInitialState } from './connection-form-defaults'

function summary(overrides: Partial<DbConnectionSummary> = {}): DbConnectionSummary {
  return {
    id: 'c1',
    name: 'db',
    engine: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'app',
    user: 'admin',
    ssl: undefined,
    readOnly: false,
    hasPassword: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

// Regression: Radix <SelectItem> forbids an empty-string value, so the SSL
// field's "Auto" sentinel must be a non-empty string ('auto'), never ''.
describe('buildInitialState SSL sentinel', () => {
  it('defaults a brand-new connection to the auto sentinel, not empty string', () => {
    const state = buildInitialState(undefined)
    expect(state.ssl).toBe('auto')
    expect(state.ssl).not.toBe('')
  })

  it('maps an unset stored ssl to the auto sentinel', () => {
    expect(buildInitialState(summary({ ssl: undefined })).ssl).toBe('auto')
  })

  it('preserves an explicit ssl mode', () => {
    expect(buildInitialState(summary({ ssl: 'verify-full' })).ssl).toBe('verify-full')
    expect(buildInitialState(summary({ ssl: 'insecure-no-verify' })).ssl).toBe('insecure-no-verify')
  })

  it('never yields an empty-string ssl value', () => {
    for (const ssl of [undefined, 'disable', 'verify-full', 'insecure-no-verify'] as const) {
      expect(buildInitialState(summary({ ssl })).ssl).not.toBe('')
    }
  })
})
