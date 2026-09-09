import { beforeEach, describe, expect, it } from 'vitest'
import type { StableAutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import { buildAutomationHostCatalog } from './automation-host-catalog'
import {
  createAutomationCatalogGenerationRegistry,
  getAuthorityCatalogGeneration,
  resetAutomationHostCatalogGenerationsForTests,
  syncAutomationHostCatalogGenerations
} from './automation-host-catalog-generation'
import type {
  AutomationCatalogSshMirrorInput,
  AutomationHostCatalogInput,
  AutomationRuntimeAuthorityInput
} from './automation-host-catalog-types'

const DESKTOP: StableAutomationAuthorityRef = { kind: 'desktop' }
const ENV_A: StableAutomationAuthorityRef = { kind: 'runtime', environmentId: 'env-a' }
const ENV_B: StableAutomationAuthorityRef = { kind: 'runtime', environmentId: 'env-b' }

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
  environmentId: string,
  overrides: Partial<AutomationRuntimeAuthorityInput> = {}
): AutomationRuntimeAuthorityInput {
  return {
    environmentId,
    label: environmentId,
    pairingRevision: 1,
    authorityHealth: 'fresh',
    querySupport: 'scoped',
    ssh: mirror(),
    ...overrides
  }
}

function input(overrides: Partial<AutomationHostCatalogInput> = {}): AutomationHostCatalogInput {
  return {
    desktop: { label: 'Local Mac', ssh: mirror() },
    runtimes: [runtime('env-a'), runtime('env-b')],
    runtimeCatalogSettled: true,
    ...overrides
  }
}

describe('automation catalog generation', () => {
  let registry = createAutomationCatalogGenerationRegistry()

  beforeEach(() => {
    registry = createAutomationCatalogGenerationRegistry()
  })

  it('advances every authority on the first sync', () => {
    registry.sync(buildAutomationHostCatalog(input()))
    expect(registry.get(DESKTOP)).toBe(1)
    expect(registry.get(ENV_A)).toBe(1)
    expect(registry.get(ENV_B)).toBe(1)
  })

  it('advances only the authority whose target bucket hydrated', () => {
    registry.sync(
      buildAutomationHostCatalog(
        input({
          runtimes: [
            runtime('env-a', { ssh: mirror({ targetsHydrated: false }) }),
            runtime('env-b')
          ]
        })
      )
    )
    const before = {
      desktop: registry.get(DESKTOP),
      a: registry.get(ENV_A),
      b: registry.get(ENV_B)
    }
    const advanced = registry.sync(
      buildAutomationHostCatalog(
        input({
          runtimes: [
            runtime('env-a', {
              ssh: mirror({ targets: [{ targetId: 't', label: 'T', generation: 2 }] })
            }),
            runtime('env-b')
          ]
        })
      )
    )
    expect(advanced.advancedAuthorityKeys).toEqual(['authority:runtime:env-a'])
    expect(registry.get(ENV_A)).toBe(before.a + 1)
    expect(registry.get(ENV_B)).toBe(before.b)
    expect(registry.get(DESKTOP)).toBe(before.desktop)
  })

  it('does not advance on runtime or SSH connection status changes', () => {
    const targets = [{ targetId: 't', label: 'T', generation: 2 }]
    registry.sync(
      buildAutomationHostCatalog(
        input({
          runtimes: [
            runtime('env-a', {
              ssh: mirror({ targets, connectionStatusByTargetId: new Map([['t', 'connected']]) })
            }),
            runtime('env-b')
          ]
        })
      )
    )
    const before = registry.get(ENV_A)
    const advanced = registry.sync(
      buildAutomationHostCatalog(
        input({
          runtimes: [
            runtime('env-a', {
              authorityHealth: 'stale-error',
              ssh: mirror({ targets, connectionStatusByTargetId: new Map([['t', 'reconnecting']]) })
            }),
            runtime('env-b')
          ]
        })
      )
    )
    expect(advanced.advancedAuthorityKeys).toEqual([])
    expect(registry.get(ENV_A)).toBe(before)
  })

  it('does not advance on a rename', () => {
    registry.sync(buildAutomationHostCatalog(input()))
    const before = registry.get(ENV_A)
    registry.sync(
      buildAutomationHostCatalog(
        input({ runtimes: [runtime('env-a', { label: 'Renamed' }), runtime('env-b')] })
      )
    )
    expect(registry.get(ENV_A)).toBe(before)
  })

  it('advances on a same-id re-pair', () => {
    registry.sync(buildAutomationHostCatalog(input()))
    const before = registry.get(ENV_A)
    const advanced = registry.sync(
      buildAutomationHostCatalog(
        input({ runtimes: [runtime('env-a', { pairingRevision: 2 }), runtime('env-b')] })
      )
    )
    expect(registry.get(ENV_A)).toBe(before + 1)
    expect(registry.get(ENV_B)).toBe(1)
    expect(advanced.reincarnatedStableKeys).toEqual(['host:runtime:env-a:self'])
  })

  // doc:321 — the entry a same-id re-adoption produces is byte-identical apart
  // from this, so the caller has no other way to know its rows are obsolete.
  it('reports a same-id SSH re-adoption as a reincarnated host', () => {
    const desktopAt = (generation: number, label = 'Box'): AutomationHostCatalogInput =>
      input({
        desktop: {
          label: 'Local Mac',
          ssh: mirror({ targets: [{ targetId: 'ssh-1', label, generation }] })
        }
      })
    const first = registry.sync(buildAutomationHostCatalog(desktopAt(4)))
    expect(first.reincarnatedStableKeys).toEqual([])

    const renamed = registry.sync(buildAutomationHostCatalog(desktopAt(4, 'Renamed')))
    expect(renamed.reincarnatedStableKeys).toEqual([])

    const readopted = registry.sync(buildAutomationHostCatalog(desktopAt(5)))
    expect(readopted.reincarnatedStableKeys).toEqual(['host:desktop:ssh:ssh-1'])
    expect(readopted.advancedAuthorityKeys).toEqual(['authority:desktop'])
  })

  // The generation file's own warning: an offline authority reported as
  // legacy-unscoped loses its owner refs, which must not read as a re-adoption.
  it('does not report a host whose owner merely went absent', () => {
    const withSupport = (querySupport: 'scoped' | 'legacy-unscoped'): AutomationHostCatalogInput =>
      input({
        runtimes: [
          runtime('env-a', {
            querySupport,
            // An SSH entry is where the owner ref actually disappears with the support level.
            ssh: mirror({ targets: [{ targetId: 't', label: 'T', generation: 3 }] })
          })
        ]
      })
    registry.sync(buildAutomationHostCatalog(withSupport('scoped')))

    const degraded = registry.sync(buildAutomationHostCatalog(withSupport('legacy-unscoped')))
    expect(degraded.reincarnatedStableKeys).toEqual([])

    const restored = registry.sync(buildAutomationHostCatalog(withSupport('scoped')))
    expect(restored.reincarnatedStableKeys).toEqual([])
  })

  it('advances once when an authority leaves the catalog and stays put afterwards', () => {
    registry.sync(buildAutomationHostCatalog(input()))
    registry.sync(buildAutomationHostCatalog(input({ runtimes: [runtime('env-a')] })))
    const afterRemoval = registry.get(ENV_B)
    expect(afterRemoval).toBe(2)
    registry.sync(buildAutomationHostCatalog(input({ runtimes: [runtime('env-a')] })))
    expect(registry.get(ENV_B)).toBe(afterRemoval)
  })

  it('exposes a module-level registry for the cache fence', () => {
    resetAutomationHostCatalogGenerationsForTests()
    expect(getAuthorityCatalogGeneration(DESKTOP)).toBe(0)
    syncAutomationHostCatalogGenerations(buildAutomationHostCatalog(input()))
    expect(getAuthorityCatalogGeneration(DESKTOP)).toBe(1)
    resetAutomationHostCatalogGenerationsForTests()
    expect(getAuthorityCatalogGeneration(DESKTOP)).toBe(0)
  })
})
