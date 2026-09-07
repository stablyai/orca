import { describe, expect, it } from 'vitest'
import type {
  AutomationAuthorityHealth,
  AutomationExecutionHealth,
  AutomationHostCatalogEntry,
  AutomationHostScopeGap
} from './automation-host-catalog-types'
import { hostScopeDescriptor } from './automation-host-scope-descriptors'
import {
  authorityHealthDescriptor,
  automationHostRecoveryActions,
  executionHealthDescriptor
} from './automation-host-status-descriptors'

const AUTHORITY_HEALTHS: AutomationAuthorityHealth[] = [
  'loading',
  'fresh',
  'refreshing',
  'stale-error',
  'unavailable',
  'incompatible'
]
const SCOPE_GAPS: AutomationHostScopeGap[] = [
  'target-removed',
  'target-unverified',
  'target-unregistered',
  'authority-unscoped'
]
const EXECUTION_HEALTHS: AutomationExecutionHealth[] = [
  'connected',
  'connecting',
  'disconnected',
  'unavailable',
  'unknown'
]

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

describe('automation host status descriptors', () => {
  it('gives every authority health a distinct id and non-empty copy', () => {
    const ids = AUTHORITY_HEALTHS.map((health) => authorityHealthDescriptor(health).id)
    expect(new Set(ids).size).toBe(AUTHORITY_HEALTHS.length)
    for (const health of AUTHORITY_HEALTHS) {
      const descriptor = authorityHealthDescriptor(health)
      expect(descriptor.label).not.toBe('')
      expect(descriptor.description).not.toBe('')
    }
  })

  it('gives every execution health a distinct id that cannot collide with an authority id', () => {
    const authorityIds = new Set(AUTHORITY_HEALTHS.map((h) => authorityHealthDescriptor(h).id))
    const executionIds = EXECUTION_HEALTHS.map((h) => executionHealthDescriptor(h).id)
    expect(new Set(executionIds).size).toBe(EXECUTION_HEALTHS.length)
    expect(executionIds.some((id) => authorityIds.has(id))).toBe(false)
  })

  it('treats only fresh and connected as resting states', () => {
    expect(AUTHORITY_HEALTHS.filter((h) => authorityHealthDescriptor(h).isDefault)).toEqual([
      'fresh'
    ])
    expect(EXECUTION_HEALTHS.filter((h) => executionHealthDescriptor(h).isDefault)).toEqual([
      'connected'
    ])
  })

  it('never renders an unknown connection as a failure', () => {
    expect(executionHealthDescriptor('unknown').tone).toBe('quiet')
  })

  it('badges only the degraded query contracts, and distinguishes them', () => {
    expect(hostScopeDescriptor(entry())).toBeNull()
    expect(hostScopeDescriptor(entry({ querySupport: 'incompatible' }))?.id).toBe(
      'query-incompatible'
    )
    const gapIds = SCOPE_GAPS.map(
      (scopeGap) => hostScopeDescriptor(entry({ querySupport: 'legacy-unscoped', scopeGap }))?.id
    )
    expect(new Set(gapIds).size).toBe(SCOPE_GAPS.length)
  })

  it('falls back to the authority contract when no cause was recorded', () => {
    expect(hostScopeDescriptor(entry({ querySupport: 'legacy-unscoped' }))?.id).toBe(
      'query-legacy-unscoped'
    )
  })

  it('blames the server only when the server itself answered without host scoping', () => {
    const blamesServer = (scopeGap: AutomationHostScopeGap): boolean =>
      /server/i.test(
        hostScopeDescriptor(entry({ querySupport: 'legacy-unscoped', scopeGap }))?.description ?? ''
      )
    expect(SCOPE_GAPS.filter(blamesServer)).toEqual(['authority-unscoped'])
  })
})

describe('automation host recovery actions', () => {
  it('resolves the two axes independently', () => {
    expect(
      automationHostRecoveryActions(
        entry({ authorityHealth: 'stale-error', executionHealth: 'disconnected' })
      )
    ).toEqual({ authority: 'retry', execution: 'reconnect' })
  })

  it('offers no action while a healthy host is merely loading', () => {
    expect(automationHostRecoveryActions(entry({ authorityHealth: 'loading' }))).toEqual({
      authority: null,
      execution: null
    })
  })

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

  it('reconnects rather than retries when the authority itself is unreachable', () => {
    expect(automationHostRecoveryActions(entry({ authorityHealth: 'unavailable' })).authority).toBe(
      'reconnect'
    )
  })

  it('leaves the execution axis alone while the target is connecting', () => {
    expect(
      automationHostRecoveryActions(entry({ executionHealth: 'connecting' })).execution
    ).toBeNull()
  })
})
