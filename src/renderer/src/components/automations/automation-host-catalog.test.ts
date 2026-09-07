import { describe, expect, it, vi } from 'vitest'
import { hostStableKey, ownerKey } from '../../../../shared/automation-owner-key'
import { RUNTIME_OWNED_SSH_TARGET_ID_PREFIX } from '../../../../shared/execution-host'
import {
  AUTOMATION_ORPHAN_ENTRY_LABEL,
  buildAutomationHostCatalog
} from './automation-host-catalog'
import type {
  AutomationCatalogSshMirrorInput,
  AutomationHostCatalog,
  AutomationHostCatalogEntry,
  AutomationHostCatalogInput,
  AutomationRuntimeAuthorityInput
} from './automation-host-catalog-types'

function mirror(
  overrides: Partial<AutomationCatalogSshMirrorInput> = {}
): AutomationCatalogSshMirrorInput {
  return {
    targetsHydrated: true,
    targets: [],
    removedTargetLabels: new Map(),
    connectionStatusByTargetId: new Map(),
    ...overrides
  }
}

function runtime(
  overrides: Partial<AutomationRuntimeAuthorityInput> = {}
): AutomationRuntimeAuthorityInput {
  return {
    environmentId: 'env-1',
    label: 'Build server',
    pairingRevision: 7,
    authorityHealth: 'fresh',
    querySupport: 'scoped',
    ssh: mirror(),
    ...overrides
  }
}

function buildInput(
  overrides: Partial<AutomationHostCatalogInput> = {}
): AutomationHostCatalogInput {
  return {
    desktop: { label: 'Local Mac', ssh: mirror({ missingConnectionStatus: 'disconnected' }) },
    runtimes: [],
    runtimeCatalogSettled: true,
    ...overrides
  }
}

function entryAt(catalog: AutomationHostCatalog, key: string): AutomationHostCatalogEntry {
  const entry = catalog.byStableKey.get(key)
  if (!entry) {
    throw new Error(`missing catalog entry: ${key}`)
  }
  return entry
}

const DESKTOP_SELF_KEY = hostStableKey({
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
})

function desktopSshKey(targetId: string): string {
  return hostStableKey({ authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId } })
}

function runtimeSelfKey(environmentId: string): string {
  return hostStableKey({
    authority: { kind: 'runtime', environmentId },
    selector: { kind: 'self' }
  })
}

function runtimeSshKey(environmentId: string, targetId: string): string {
  return hostStableKey({
    authority: { kind: 'runtime', environmentId },
    selector: { kind: 'ssh', targetId }
  })
}

describe('buildAutomationHostCatalog', () => {
  it('projects Desktop + Self as immediately authoritative', () => {
    const catalog = buildAutomationHostCatalog(buildInput())
    const self = entryAt(catalog, DESKTOP_SELF_KEY)
    expect(self).toMatchObject({
      kind: 'self',
      label: 'Local Mac',
      catalogState: 'authoritative',
      executionHealth: 'connected',
      querySupport: 'scoped'
    })
    expect(self.owner).toEqual({ authority: { kind: 'desktop' }, selector: { kind: 'self' } })
  })

  it('keeps equal SSH target ids under Desktop and a runtime distinct', () => {
    const catalog = buildAutomationHostCatalog(
      buildInput({
        desktop: {
          label: 'Local Mac',
          ssh: mirror({
            targets: [{ targetId: 'shared', label: 'Desktop box', generation: 3 }],
            connectionStatusByTargetId: new Map([['shared', 'connected']])
          })
        },
        runtimes: [
          runtime({
            ssh: mirror({
              targets: [{ targetId: 'shared', label: 'Runtime box', generation: 11 }],
              connectionStatusByTargetId: new Map([['shared', 'disconnected']])
            })
          })
        ]
      })
    )
    const desktop = entryAt(catalog, desktopSshKey('shared'))
    const nested = entryAt(catalog, runtimeSshKey('env-1', 'shared'))
    expect(desktop.stableKey).not.toBe(nested.stableKey)
    expect(desktop.label).toBe('Desktop box')
    expect(nested.label).toBe('Runtime box')
    expect(desktop.executionHealth).toBe('connected')
    expect(nested.executionHealth).toBe('disconnected')
    expect(ownerKey(desktop.owner!)).not.toBe(ownerKey(nested.owner!))
    expect(nested.owner).toEqual({
      authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 7 },
      selector: { kind: 'ssh', targetId: 'shared', targetGeneration: 11 }
    })
  })

  it('keeps equal SSH target ids under two runtimes distinct', () => {
    const catalog = buildAutomationHostCatalog(
      buildInput({
        runtimes: [
          runtime({
            environmentId: 'env-a',
            label: 'A',
            ssh: mirror({ targets: [{ targetId: 'shared', label: 'A box', generation: 1 }] })
          }),
          runtime({
            environmentId: 'env-b',
            label: 'B',
            ssh: mirror({ targets: [{ targetId: 'shared', label: 'B box', generation: 1 }] })
          })
        ]
      })
    )
    expect(entryAt(catalog, runtimeSshKey('env-a', 'shared')).label).toBe('A box')
    expect(entryAt(catalog, runtimeSshKey('env-b', 'shared')).label).toBe('B box')
    expect(catalog.entries.filter((entry) => entry.kind === 'ssh')).toHaveLength(2)
  })

  it('projects Runtime + Self while the runtime is offline', () => {
    const catalog = buildAutomationHostCatalog(
      buildInput({ runtimes: [runtime({ authorityHealth: 'unavailable' })] })
    )
    const self = entryAt(catalog, runtimeSelfKey('env-1'))
    expect(self).toMatchObject({
      catalogState: 'authoritative',
      authorityHealth: 'unavailable',
      executionHealth: 'disconnected',
      label: 'Build server'
    })
    expect(self.owner).not.toBeNull()
  })

  it('preserves nested labels through a parent outage without claiming removal', () => {
    const catalog = buildAutomationHostCatalog(
      buildInput({
        runtimes: [
          runtime({
            authorityHealth: 'unavailable',
            ssh: mirror({
              targetsHydrated: false,
              targets: [{ targetId: 'nested', label: 'Nested box', generation: 4 }]
            })
          })
        ]
      })
    )
    const nested = entryAt(catalog, runtimeSshKey('env-1', 'nested'))
    expect(nested.label).toBe('Nested box')
    expect(nested.catalogState).toBe('unhydrated')
    expect(nested.executionHealth).toBe('unknown')
    // Unverified state must never carry a fencing owner.
    expect(nested.owner).toBeNull()
  })

  it('never copies nested runtime targets into the desktop authority', () => {
    const catalog = buildAutomationHostCatalog(
      buildInput({
        runtimes: [
          runtime({
            ssh: mirror({ targets: [{ targetId: 'only-nested', label: 'N', generation: 2 }] })
          })
        ]
      })
    )
    expect(catalog.byStableKey.has(desktopSshKey('only-nested'))).toBe(false)
    expect(
      catalog.entries.filter((entry) => entry.stableRef.authority.kind === 'desktop')
    ).toHaveLength(1)
  })

  it('hides runtime-owned ephemeral SSH targets from both authorities', () => {
    const ephemeral = `${RUNTIME_OWNED_SSH_TARGET_ID_PREFIX}vm-1`
    const catalog = buildAutomationHostCatalog(
      buildInput({
        desktop: {
          label: 'Local Mac',
          ssh: mirror({
            targets: [{ targetId: ephemeral, label: 'VM', generation: 1 }],
            removedTargetLabels: new Map([[ephemeral, 'VM']])
          })
        },
        runtimes: [
          runtime({
            ssh: mirror({ targets: [{ targetId: ephemeral, label: 'VM', generation: 1 }] })
          })
        ],
        referencedStableKeys: [desktopSshKey(ephemeral), runtimeSshKey('env-1', ephemeral)]
      })
    )
    expect(catalog.entries.some((entry) => entry.kind === 'ssh')).toBe(false)
  })

  it('marks a tombstoned target removed and keeps its last known label', () => {
    const catalog = buildAutomationHostCatalog(
      buildInput({
        desktop: {
          label: 'Local Mac',
          ssh: mirror({ removedTargetLabels: new Map([['gone', 'Old box']]) })
        }
      })
    )
    const ghost = entryAt(catalog, desktopSshKey('gone'))
    expect(ghost).toMatchObject({
      label: 'Old box',
      catalogState: 'removed',
      executionHealth: 'unavailable',
      owner: null
    })
  })

  it('treats absence as removal only once the target list hydrated', () => {
    const referenced = [desktopSshKey('referenced')]
    const hydrated = buildAutomationHostCatalog(buildInput({ referencedStableKeys: referenced }))
    expect(entryAt(hydrated, desktopSshKey('referenced')).catalogState).toBe('removed')

    const unhydrated = buildAutomationHostCatalog(
      buildInput({
        desktop: { label: 'Local Mac', ssh: mirror({ targetsHydrated: false }) },
        referencedStableKeys: referenced
      })
    )
    const entry = entryAt(unhydrated, desktopSshKey('referenced'))
    expect(entry.catalogState).toBe('unhydrated')
    expect(entry.executionHealth).toBe('unknown')
  })

  it('keeps a legacy runtime view-only: no generations, no owners', () => {
    const catalog = buildAutomationHostCatalog(
      buildInput({
        runtimes: [
          runtime({
            querySupport: 'legacy-unscoped',
            ssh: mirror({ targets: [{ targetId: 'legacy', label: 'Legacy box' }] })
          })
        ]
      })
    )
    const nested = entryAt(catalog, runtimeSshKey('env-1', 'legacy'))
    expect(nested.querySupport).toBe('legacy-unscoped')
    expect(nested.owner).toBeNull()
    // Self needs no target generation, so it stays owned even on an old server.
    expect(entryAt(catalog, runtimeSelfKey('env-1')).owner).not.toBeNull()
  })

  it('downgrades a scoped entry whose target carries no generation', () => {
    const catalog = buildAutomationHostCatalog(
      buildInput({
        runtimes: [runtime({ ssh: mirror({ targets: [{ targetId: 'ungenerated', label: 'U' }] }) })]
      })
    )
    const nested = entryAt(catalog, runtimeSshKey('env-1', 'ungenerated'))
    expect(nested.querySupport).toBe('legacy-unscoped')
    expect(nested.owner).toBeNull()
  })

  it('blames the removed target, not a server, for a desktop ghost entry', () => {
    const catalog = buildAutomationHostCatalog(
      buildInput({
        desktop: {
          label: 'Local Mac',
          ssh: mirror({ removedTargetLabels: new Map([['gone', 'Old box']]) })
        },
        referencedStableKeys: [desktopSshKey('gone')]
      })
    )
    const ghost = entryAt(catalog, desktopSshKey('gone'))
    expect({ catalogState: ghost.catalogState, scopeGap: ghost.scopeGap }).toEqual({
      catalogState: 'removed',
      scopeGap: 'target-removed'
    })
  })

  it('marks a modern runtime unverified, not unscoped, while its SSH bucket is stale', () => {
    // markEnvironmentSshStateStale keeps labels but drops generations and hydration.
    const catalog = buildAutomationHostCatalog(
      buildInput({
        runtimes: [
          runtime({
            querySupport: 'scoped',
            ssh: mirror({ targetsHydrated: false, targets: [{ targetId: 'box', label: 'Box' }] })
          })
        ]
      })
    )
    const nested = entryAt(catalog, runtimeSshKey('env-1', 'box'))
    expect(nested.scopeGap).toBe('target-unverified')
    expect(nested.owner).toBeNull()
  })

  it('keeps target execution health independent of authority query health', () => {
    const catalog = buildAutomationHostCatalog(
      buildInput({
        runtimes: [
          runtime({
            ssh: mirror({
              targets: [{ targetId: 'down', label: 'Down box', generation: 5 }],
              connectionStatusByTargetId: new Map([['down', 'auth-failed']])
            })
          })
        ]
      })
    )
    const nested = entryAt(catalog, runtimeSshKey('env-1', 'down'))
    expect(nested.executionHealth).toBe('disconnected')
    expect(nested.authorityHealth).toBe('fresh')
    expect(nested.owner).not.toBeNull()
  })

  it('adds an orphan entry for a positive count and omits an empty one', () => {
    expect(
      buildAutomationHostCatalog(buildInput()).entries.some((entry) => entry.kind === 'orphan')
    ).toBe(false)
    expect(
      buildAutomationHostCatalog(
        buildInput({ desktop: { label: 'Local Mac', ssh: mirror(), orphanCount: 0 } })
      ).entries.some((entry) => entry.kind === 'orphan')
    ).toBe(false)

    const catalog = buildAutomationHostCatalog(
      buildInput({ desktop: { label: 'Local Mac', ssh: mirror(), orphanCount: 2 } })
    )
    const orphan = catalog.entries.find((entry) => entry.kind === 'orphan')
    expect(orphan).toMatchObject({
      label: AUTOMATION_ORPHAN_ENTRY_LABEL,
      catalogState: 'authoritative',
      executionHealth: 'unavailable',
      owner: null
    })
  })

  it('keeps a referenced orphan entry unhydrated until its authority answers', () => {
    const key = hostStableKey({ authority: { kind: 'desktop' }, selector: { kind: 'orphan' } })
    const catalog = buildAutomationHostCatalog(buildInput({ referencedStableKeys: [key] }))
    expect(entryAt(catalog, key).catalogState).toBe('unhydrated')
  })

  it('preserves the stable key and owner slot across a rename', () => {
    const before = buildAutomationHostCatalog(
      buildInput({
        runtimes: [
          runtime({
            ssh: mirror({ targets: [{ targetId: 't1', label: 'Old name', generation: 9 }] })
          })
        ]
      })
    )
    const after = buildAutomationHostCatalog(
      buildInput({
        runtimes: [
          runtime({
            label: 'Renamed server',
            ssh: mirror({ targets: [{ targetId: 't1', label: 'New name', generation: 9 }] })
          })
        ]
      })
    )
    const key = runtimeSshKey('env-1', 't1')
    expect(entryAt(after, key).stableKey).toBe(entryAt(before, key).stableKey)
    expect(ownerKey(entryAt(after, key).owner!)).toBe(ownerKey(entryAt(before, key).owner!))
    expect(entryAt(after, key).label).toBe('New name')
  })

  it('reports hydration evidence for every absence gate', () => {
    const catalog = buildAutomationHostCatalog(
      buildInput({
        runtimeCatalogSettled: false,
        desktop: { label: 'Local Mac', ssh: mirror({ targetsHydrated: false }), orphanCount: 1 },
        runtimes: [
          runtime({ authorityHealth: 'unavailable', ssh: mirror({ targetsHydrated: false }) }),
          runtime({ environmentId: 'env-2', label: 'Second' })
        ]
      })
    )
    expect(catalog.hydration.runtimeCatalogSettled).toBe(false)
    expect(catalog.hydration.desktopSshHydrated).toBe(false)
    expect(catalog.hydration.savedRuntimeEnvironmentIds).toEqual(new Set(['env-1', 'env-2']))
    expect(catalog.hydration.runtimeSshHydratedByEnvironmentId.get('env-1')).toBe(false)
    expect(catalog.hydration.runtimeSshHydratedByEnvironmentId.get('env-2')).toBe(true)
    expect([...catalog.hydration.orphanSettledAuthorityKeys]).toEqual(['authority:desktop'])
    expect([...catalog.hydration.unavailableAuthorityKeys]).toEqual(['authority:runtime:env-1'])
  })

  it('ignores unparseable referenced keys instead of throwing', () => {
    expect(() =>
      buildAutomationHostCatalog(buildInput({ referencedStableKeys: ['nonsense', ''] }))
    ).not.toThrow()
  })

  it('performs no network, runtime, or SSH side effects', () => {
    const fetchSpy = vi.fn()
    const socketSpy = vi.fn()
    const globals = globalThis as Record<string, unknown>
    const previous = { fetch: globals.fetch, WebSocket: globals.WebSocket, window: globals.window }
    globals.fetch = fetchSpy
    globals.WebSocket = socketSpy
    globals.window = new Proxy(
      {},
      {
        get: (_target, property) => {
          throw new Error(`projection touched window.${String(property)}`)
        }
      }
    )
    try {
      const catalog = buildAutomationHostCatalog(
        buildInput({
          runtimes: [
            runtime({
              ssh: mirror({ targets: [{ targetId: 't', label: 'T', generation: 1 }] }),
              orphanCount: 3
            })
          ]
        })
      )
      expect(catalog.entries.length).toBeGreaterThan(0)
    } finally {
      globals.fetch = previous.fetch
      globals.WebSocket = previous.WebSocket
      globals.window = previous.window
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(socketSpy).not.toHaveBeenCalled()
  })
})
