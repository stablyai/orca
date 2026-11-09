import { describe, expect, it } from 'vitest'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'

import { automationHostRecoveryActions } from './automation-host-status-descriptors'

function entry(overrides: Partial<AutomationHostCatalogEntry> = {}): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 't1' } },
    owner: null,
    stableKey: 'host:desktop:ssh:t1',
    label: 'web-01',
    authorityLabel: 'This computer',
    kind: 'ssh',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    ...overrides
  }
}

describe('automation host recovery actions', () => {
  it('asks for a server update when the authority itself lacks host scoping', () => {
    expect(
      automationHostRecoveryActions(
        entry({ querySupport: 'legacy-unscoped', scopeGap: 'authority-unscoped' })
      ).authority
    ).toBe('update-server')
    expect(
      automationHostRecoveryActions(entry({ authorityHealth: 'incompatible' })).authority
    ).toBe('update-server')
  })

  it('never offers a server update for a host that was removed', () => {
    expect(
      automationHostRecoveryActions(
        entry({
          catalogState: 'removed',
          executionHealth: 'unavailable',
          querySupport: 'legacy-unscoped',
          scopeGap: 'target-removed'
        })
      )
    ).toEqual({ authority: null, execution: null })
  })

  it('offers Reconnect, not a server update, for a target with no verified registration', () => {
    expect(
      automationHostRecoveryActions(
        entry({
          catalogState: 'unhydrated',
          executionHealth: 'unknown',
          querySupport: 'legacy-unscoped',
          scopeGap: 'target-unverified'
        })
      )
    ).toEqual({ authority: 'reconnect', execution: null })
  })

  it('offers no repair for a live target the authority never registered', () => {
    expect(
      automationHostRecoveryActions(
        entry({ querySupport: 'legacy-unscoped', scopeGap: 'target-unregistered' })
      ).authority
    ).toBeNull()
  })
})
