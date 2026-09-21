import { describe, expect, it, vi } from 'vitest'
import { buildAutomationHostCatalog } from './automation-host-catalog'
import { orderAutomationHostCatalogEntries } from './automation-host-catalog-order'
import type {
  AutomationCatalogSshMirrorInput,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'

function mirror(
  targets: { targetId: string; label: string }[],
  overrides: Partial<AutomationCatalogSshMirrorInput> = {}
): AutomationCatalogSshMirrorInput {
  return {
    targetsHydrated: true,
    targets: targets.map((target) => ({ ...target, generation: 1 })),
    removedTargetLabels: new Map(),
    connectionStatusByTargetId: new Map(),
    ...overrides
  }
}

function describeEntry(entry: AutomationHostCatalogEntry): string {
  const authority = entry.stableRef.authority
  const prefix = authority.kind === 'desktop' ? 'desktop' : authority.environmentId
  return `${prefix}/${entry.kind}:${entry.label}`
}

describe('orderAutomationHostCatalogEntries', () => {
  it('orders desktop first, then runtimes, with orphans last inside each authority', () => {
    const catalog = buildAutomationHostCatalog({
      desktop: {
        label: 'Local Mac',
        ssh: mirror([
          { targetId: 'z', label: 'zeta' },
          { targetId: 'a', label: 'alpha' }
        ]),
        orphanCount: 1
      },
      runtimes: [
        {
          environmentId: 'env-z',
          label: 'Zulu',
          pairingRevision: 1,
          authorityHealth: 'fresh',
          querySupport: 'scoped',
          ssh: mirror([{ targetId: 'zt', label: 'zulu target' }]),
          orphanCount: 4
        },
        {
          environmentId: 'env-a',
          label: 'Alpha',
          pairingRevision: 1,
          authorityHealth: 'fresh',
          querySupport: 'scoped',
          ssh: mirror([
            { targetId: 'b2', label: 'beta' },
            { targetId: 'a2', label: 'Ampere' }
          ])
        }
      ],
      runtimeCatalogSettled: true
    })
    expect(catalog.entries.map(describeEntry)).toEqual([
      'desktop/self:Local Mac',
      'desktop/ssh:alpha',
      'desktop/ssh:zeta',
      'desktop/orphan:Unassigned legacy automations',
      'env-a/self:Alpha',
      'env-a/ssh:Ampere',
      'env-a/ssh:beta',
      'env-z/self:Zulu',
      'env-z/ssh:zulu target',
      'env-z/orphan:Unassigned legacy automations'
    ])
  })

  it('breaks equal labels by target id and equal authority labels by environment id', () => {
    const catalog = buildAutomationHostCatalog({
      desktop: {
        label: 'Local Mac',
        ssh: mirror([
          { targetId: 'zzz', label: 'same' },
          { targetId: 'aaa', label: 'same' }
        ])
      },
      runtimes: ['env-b', 'env-a'].map((environmentId) => ({
        environmentId,
        label: 'Tied',
        pairingRevision: 1,
        authorityHealth: 'fresh' as const,
        querySupport: 'scoped' as const,
        ssh: mirror([])
      })),
      runtimeCatalogSettled: true
    })
    expect(catalog.entries.map(describeEntry)).toEqual([
      'desktop/self:Local Mac',
      'desktop/ssh:same',
      'desktop/ssh:same',
      'env-a/self:Tied',
      'env-b/self:Tied'
    ])
    const desktopSsh = catalog.entries.filter((entry) => entry.kind === 'ssh')
    expect(desktopSsh.map((entry) => entry.stableRef.selector)).toEqual([
      { kind: 'ssh', targetId: 'aaa' },
      { kind: 'ssh', targetId: 'zzz' }
    ])
  })

  it('sorts labels with a locale-aware collator', () => {
    const catalog = buildAutomationHostCatalog({
      desktop: {
        label: 'Local Mac',
        ssh: mirror([
          { targetId: '1', label: 'box-10' },
          { targetId: '2', label: 'box-2' },
          { targetId: '3', label: 'Ähnlich' }
        ])
      },
      runtimes: [],
      runtimeCatalogSettled: true
    })
    expect(
      catalog.entries.filter((entry) => entry.kind === 'ssh').map((entry) => entry.label)
    ).toEqual(['Ähnlich', 'box-2', 'box-10'])
  })

  it('constructs exactly one collator per rebuild', () => {
    const catalog = buildAutomationHostCatalog({
      desktop: {
        label: 'Local Mac',
        ssh: mirror(
          Array.from({ length: 40 }, (_unused, index) => ({
            targetId: `t${index}`,
            label: `host ${index}`
          }))
        )
      },
      runtimes: [],
      runtimeCatalogSettled: true
    })
    const createCollator = vi.fn(() => new Intl.Collator(undefined, { numeric: true }))
    orderAutomationHostCatalogEntries(catalog.entries, { createCollator })
    expect(createCollator).toHaveBeenCalledTimes(1)
  })

  it('is a pure reordering', () => {
    const catalog = buildAutomationHostCatalog({
      desktop: { label: 'Local Mac', ssh: mirror([{ targetId: 'a', label: 'A' }]) },
      runtimes: [],
      runtimeCatalogSettled: true
    })
    const input = catalog.entries.toReversed()
    const ordered = orderAutomationHostCatalogEntries(input)
    expect(input).toEqual(catalog.entries.toReversed())
    expect(new Set(ordered)).toEqual(new Set(catalog.entries))
  })
})
