import { describe, expect, it } from 'vitest'
import { orderAutomationHostCatalogEntries } from './automation-host-catalog-order'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import { groupAutomationHostEntriesByAuthority } from './automation-host-picker-groups'

function desktopSsh(targetId: string, label: string): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId } },
    owner: null,
    stableKey: `host:desktop:ssh:${targetId}`,
    label,
    authorityLabel: 'This computer',
    kind: 'ssh',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped'
  }
}

function runtimeSelf(environmentId: string, label: string): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'runtime', environmentId }, selector: { kind: 'self' } },
    owner: null,
    stableKey: `host:runtime:${environmentId}:self`,
    label,
    authorityLabel: label,
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped'
  }
}

describe('automation host picker groups', () => {
  it('groups by authority while preserving the shared catalog order', () => {
    const entries = [
      runtimeSelf('env-b', 'Build box'),
      desktopSsh('t2', 'web-02'),
      desktopSsh('t1', 'web-01'),
      runtimeSelf('env-a', 'Alpha box')
    ]
    const groups = groupAutomationHostEntriesByAuthority(entries)

    expect(groups.map((group) => group.authorityLabel)).toEqual([
      'This computer',
      'Alpha box',
      'Build box'
    ])
    expect(groups.flatMap((group) => group.entries).map((entry) => entry.stableKey)).toEqual(
      orderAutomationHostCatalogEntries(entries).map((entry) => entry.stableKey)
    )
  })

  it('keeps two authorities with equal target ids in separate groups', () => {
    const collidingRuntime: AutomationHostCatalogEntry = {
      ...desktopSsh('t1', 'web-01'),
      stableRef: {
        authority: { kind: 'runtime', environmentId: 'env-a' },
        selector: { kind: 'ssh', targetId: 't1' }
      },
      stableKey: 'host:runtime:env-a:ssh:t1',
      authorityLabel: 'Alpha box'
    }
    const groups = groupAutomationHostEntriesByAuthority([
      desktopSsh('t1', 'web-01'),
      collidingRuntime
    ])

    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.entries.length)).toEqual([1, 1])
  })
})
