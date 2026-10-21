import { describe, expect, it } from 'vitest'
import { isSettingsNavigationTarget } from './settings-navigation-types'

describe('isSettingsNavigationTarget', () => {
  it('accepts a page-level host scope', () => {
    expect(
      isSettingsNavigationTarget({
        pane: 'accounts',
        repoId: null,
        hostScope: { kind: 'environment', environmentId: 'linux-box' }
      })
    ).toBe(true)
    expect(
      isSettingsNavigationTarget({ pane: 'accounts', repoId: null, hostScope: { kind: 'local' } })
    ).toBe(true)
  })

  it('rejects a malformed host scope', () => {
    for (const hostScope of ['linux-box', { kind: 'environment' }, { kind: 'ssh' }]) {
      expect(isSettingsNavigationTarget({ pane: 'accounts', repoId: null, hostScope })).toBe(false)
    }
  })
})
