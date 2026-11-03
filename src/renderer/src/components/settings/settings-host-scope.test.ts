import { describe, expect, it } from 'vitest'
import { resolveSettingsHostScope } from './settings-host-scope'

const saved = ['env-a', 'env-b']

describe('resolveSettingsHostScope', () => {
  it('marks a removed server unavailable instead of falling back to this computer', () => {
    expect(
      resolveSettingsHostScope({
        choice: { kind: 'environment', environmentId: 'env-gone' },
        defaultEnvironmentId: null,
        savedEnvironmentIds: saved,
        catalogHydrated: true
      })
    ).toEqual({ target: { kind: 'environment', environmentId: 'env-gone' }, available: false })
  })

  it('does not call a server unavailable before the saved-server list loads', () => {
    expect(
      resolveSettingsHostScope({
        choice: { kind: 'environment', environmentId: 'env-a' },
        defaultEnvironmentId: null,
        savedEnvironmentIds: [],
        catalogHydrated: false
      }).available
    ).toBe(true)
  })
})
