/**
 * The controller is where a rebuilt catalog meets the cache: it must advance
 * generations before fetching, forget hosts the catalog dropped, and leave an
 * unreachable authority alone instead of dialling it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import type {
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import { createAutomationHostCache } from './automation-host-cache'
import { createAutomationHostQueryController } from './automation-host-cache-controller'
import {
  getAuthorityCatalogGeneration,
  resetAutomationHostCatalogGenerationsForTests
} from './automation-host-catalog-generation'
import type {
  AutomationAuthorityHealth,
  AutomationHostCatalog,
  AutomationHostCatalogEntry,
  AutomationHostCatalogState,
  AutomationHostQuerySupport
} from './automation-host-catalog-types'
import type { AutomationHostSchedulerTransport } from './automation-host-scheduler'
import type { ScopedAutomationList } from './automation-scoped-list-client'

const DESKTOP: StableAutomationAuthorityRef = { kind: 'desktop' }
const RUNTIME: StableAutomationAuthorityRef = { kind: 'runtime', environmentId: 'env-1' }
const DESKTOP_SELF: StableAutomationCatalogRef = { authority: DESKTOP, selector: { kind: 'self' } }
const RUNTIME_SELF: StableAutomationCatalogRef = { authority: RUNTIME, selector: { kind: 'self' } }
const RUNTIME_SSH: StableAutomationCatalogRef = {
  authority: RUNTIME,
  selector: { kind: 'ssh', targetId: 'target-1' }
}
const DESKTOP_SSH: StableAutomationCatalogRef = {
  authority: DESKTOP,
  selector: { kind: 'ssh', targetId: 'target-1' }
}

function entry(
  ref: StableAutomationCatalogRef,
  overrides: {
    authorityHealth?: AutomationAuthorityHealth
    catalogState?: AutomationHostCatalogState
    querySupport?: AutomationHostQuerySupport
    targetGeneration?: number
  } = {}
): AutomationHostCatalogEntry {
  return {
    stableRef: ref,
    owner: {
      authority:
        ref.authority.kind === 'desktop'
          ? { kind: 'desktop' }
          : { kind: 'runtime', environmentId: ref.authority.environmentId, pairingRevision: 2 },
      selector:
        ref.selector.kind === 'ssh'
          ? {
              kind: 'ssh',
              targetId: ref.selector.targetId,
              targetGeneration: overrides.targetGeneration ?? 5
            }
          : { kind: 'self' }
    },
    stableKey: hostStableKey(ref),
    label: 'Host',
    authorityLabel: 'Authority',
    kind: ref.selector.kind === 'ssh' ? 'ssh' : 'self',
    catalogState: overrides.catalogState ?? 'authoritative',
    authorityHealth: overrides.authorityHealth ?? 'fresh',
    executionHealth: 'connected',
    querySupport: overrides.querySupport ?? 'scoped'
  }
}

function catalogOf(entries: AutomationHostCatalogEntry[]): AutomationHostCatalog {
  return {
    entries,
    byStableKey: new Map(entries.map((item) => [item.stableKey, item])),
    hydration: {
      runtimeCatalogSettled: true,
      desktopSshHydrated: true,
      runtimeSshHydratedByEnvironmentId: new Map(),
      savedRuntimeEnvironmentIds: new Set(['env-1']),
      orphanSettledAuthorityKeys: new Set(),
      unavailableAuthorityKeys: new Set()
    }
  }
}

function emptyList(): ScopedAutomationList {
  return { automations: [], items: [], orphanCount: 0, invalidRows: 0 }
}

function listOf(ids: readonly string[]): ScopedAutomationList {
  return {
    automations: ids.map((id) => ({ id, name: id }) as Automation),
    items: ids.map((id) => ({ automationId: id, selector: { kind: 'self' as const } })),
    orphanCount: 0,
    invalidRows: 0
  }
}

function createController(listScoped: AutomationHostSchedulerTransport['listScoped']) {
  const cache = createAutomationHostCache({
    catalogGeneration: () => 0,
    connectionGeneration: () => 0
  })
  const controller = createAutomationHostQueryController({
    cache,
    legacyPartitionContext: () => ({ repoConnectionId: () => null, projectsAuthoritative: true }),
    isVisible: () => true,
    schedule: (flush) => flush(),
    transport: { listScoped }
  })
  return { cache, controller }
}

/** Reads the module-level generation registry, which is the fence the renderer really runs. */
function createFencedController(listScoped: AutomationHostSchedulerTransport['listScoped']) {
  const cache = createAutomationHostCache({ connectionGeneration: () => 0 })
  const controller = createAutomationHostQueryController({
    cache,
    legacyPartitionContext: () => ({ repoConnectionId: () => null, projectsAuthoritative: true }),
    isVisible: () => true,
    schedule: (flush) => flush(),
    transport: { listScoped }
  })
  return { cache, controller }
}

afterEach(() => {
  resetAutomationHostCatalogGenerationsForTests()
})

describe('automation host query controller', () => {
  it('advances catalog generations before fetching anything', async () => {
    const listScoped = vi.fn(() => Promise.resolve(emptyList()))
    const { controller } = createController(listScoped)
    expect(getAuthorityCatalogGeneration(RUNTIME)).toBe(0)

    await controller.applyCatalog(catalogOf([entry(RUNTIME_SELF)]))

    expect(getAuthorityCatalogGeneration(RUNTIME)).toBe(1)
    expect(listScoped).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('skips removed entries and unreachable authorities but keeps the selected host', async () => {
    const listScoped = vi.fn(() => Promise.resolve(emptyList()))
    const { controller } = createController(listScoped)

    await controller.applyCatalog(
      catalogOf([
        entry(DESKTOP_SELF),
        entry(RUNTIME_SELF, { authorityHealth: 'unavailable' }),
        entry(RUNTIME_SSH, { catalogState: 'removed' })
      ])
    )
    expect(listScoped).toHaveBeenCalledTimes(1)

    await controller.applyCatalog(
      catalogOf([entry(DESKTOP_SELF), entry(RUNTIME_SELF, { authorityHealth: 'unavailable' })]),
      { selectedStableKey: hostStableKey(RUNTIME_SELF), force: true }
    )
    expect(listScoped).toHaveBeenCalledTimes(3)
    controller.dispose()
  })

  // The ordinary startup shape: SSH hydration re-applies the catalog while the
  // four-slot pool still holds a queue, and the hosts in that queue are the ones
  // that would otherwise sit at `loading` with no request and no Retry.
  it('re-fetches hosts whose queued work a second catalog apply cancelled', async () => {
    const gates: ((value: ScopedAutomationList) => void)[] = []
    const queried: string[] = []
    let blocking = true
    const listScoped = vi.fn((_authority, selector) => {
      queried.push(selector.kind === 'ssh' ? selector.targetId : selector.kind)
      if (!blocking) {
        return Promise.resolve(emptyList())
      }
      return new Promise<ScopedAutomationList>((resolve) => gates.push(resolve))
    })
    const { controller } = createController(listScoped)
    const catalog = catalogOf(
      Array.from({ length: 10 }, (_, index) =>
        entry({ authority: RUNTIME, selector: { kind: 'ssh', targetId: `target-${index}` } })
      )
    )

    const first = controller.applyCatalog(catalog)
    await Promise.resolve()
    expect(queried).toHaveLength(4)

    const second = controller.applyCatalog(catalog)
    blocking = false
    for (const resolve of gates) {
      resolve(emptyList())
    }
    await Promise.all([first, second])

    expect(new Set(queried).size).toBe(10)
    controller.dispose()
  })

  // Design doc: a manual All-host refresh bypasses TTL but leaves hosts already
  // known to fail to their own Retry rather than dialling them again.
  it('does not re-enqueue a permanently failed host on a manual refresh', async () => {
    const listScoped = vi.fn(() => Promise.reject(new Error('permission_denied')))
    const { cache, controller } = createController(listScoped)
    const catalog = catalogOf([entry(DESKTOP_SELF)])

    await controller.applyCatalog(catalog)
    expect(cache.get(DESKTOP_SELF)?.error).toMatchObject({ retryable: false })

    await controller.applyCatalog(catalog, { force: true })
    expect(listScoped).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  // doc:321 — a same-id re-adoption moves the registration generation and nothing
  // else, so rows fetched under the old one must not survive the applied catalog.
  it('re-fetches a host re-adopted under a new registration inside the TTL', async () => {
    // One row per registration, so a cached row names the incarnation it came from.
    const listScoped = vi.fn((_authority, selector) =>
      Promise.resolve(
        listOf([
          `gen-${selector.kind === 'ssh' ? selector.expectedTargetGeneration : selector.kind}`
        ])
      )
    )
    const { cache, controller } = createFencedController(listScoped)

    await controller.applyCatalog(catalogOf([entry(DESKTOP_SSH, { targetGeneration: 4 })]))
    expect(listScoped).toHaveBeenCalledTimes(1)

    await controller.applyCatalog(catalogOf([entry(DESKTOP_SSH, { targetGeneration: 5 })]))

    expect(listScoped).toHaveBeenCalledTimes(2)
    expect(listScoped.mock.calls[1]?.[1]).toMatchObject({ expectedTargetGeneration: 5 })
    expect(cache.get(DESKTOP_SSH)?.data.map((row) => row.automation.id)).toEqual(['gen-5'])
    controller.dispose()
  })

  it('forgets entries the rebuilt catalog no longer lists', async () => {
    const listScoped = vi.fn(() => Promise.resolve(listOf(['a'])))
    const { cache, controller } = createController(listScoped)

    await controller.applyCatalog(catalogOf([entry(DESKTOP_SELF), entry(RUNTIME_SELF)]))
    expect(cache.keys()).toHaveLength(2)

    await controller.applyCatalog(catalogOf([entry(DESKTOP_SELF)]))
    expect(cache.keys()).toEqual([hostStableKey(DESKTOP_SELF)])
    controller.dispose()
  })

  // Why: a positive count is what tells the next catalog to show the authority's orphan entry.
  it('reports the latest orphan count an authority returned', async () => {
    const listScoped = vi.fn(() =>
      Promise.resolve({ automations: [], items: [], orphanCount: 3, invalidRows: 0 })
    )
    const { controller } = createController(listScoped)
    expect(controller.authorityOrphanCount(RUNTIME)).toBeNull()

    await controller.applyCatalog(catalogOf([entry(RUNTIME_SELF)]))

    expect(controller.authorityOrphanCount(RUNTIME)).toBe(3)
    expect(controller.authorityOrphanCount(DESKTOP)).toBeNull()
    controller.dispose()
  })

  it('refetches only the entries an event invalidated, past the TTL', async () => {
    const listScoped = vi.fn(() => Promise.resolve(listOf(['a'])))
    const { controller } = createController(listScoped)
    await controller.applyCatalog(catalogOf([entry(DESKTOP_SELF), entry(RUNTIME_SELF)]))
    expect(listScoped).toHaveBeenCalledTimes(2)

    controller.handleAuthorityEvent({ authority: RUNTIME, selector: { kind: 'self' } })
    await Promise.resolve()
    await Promise.resolve()

    expect(listScoped).toHaveBeenCalledTimes(3)
    controller.dispose()
  })

  // Why: an event burst on an old runtime must still cost that host one unscoped call.
  it('shares one legacy request across every entry a burst invalidated', async () => {
    const cache = createAutomationHostCache({
      catalogGeneration: () => 0,
      connectionGeneration: () => 0
    })
    const listLegacy = vi.fn(() => Promise.resolve([]))
    const controller = createAutomationHostQueryController({
      cache,
      legacyPartitionContext: () => ({ repoConnectionId: () => null, projectsAuthoritative: true }),
      isVisible: () => true,
      transport: { listLegacy }
    })
    const legacy = { querySupport: 'legacy-unscoped' as const }
    await controller.applyCatalog(
      catalogOf([entry(RUNTIME_SELF, legacy), entry(RUNTIME_SSH, legacy)])
    )
    expect(listLegacy).toHaveBeenCalledTimes(1)

    controller.handleAuthorityEvent({ authority: RUNTIME, selector: { kind: 'self' } })
    controller.handleAuthorityEvent({ authority: RUNTIME, reason: 'definition' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(listLegacy).toHaveBeenCalledTimes(2)
    controller.dispose()
  })
})
