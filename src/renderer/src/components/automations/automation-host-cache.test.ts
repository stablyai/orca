/**
 * The commit fence is the whole point of this cache: an answer that was correct
 * when it was asked for may be wrong by the time it lands, and rendering it
 * would attribute one host's automations to another.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import type {
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import { createAutomationHostCache } from './automation-host-cache'
import type { AutomationHostRow } from './automation-host-cache-types'
import {
  createAutomationCatalogGenerationRegistry,
  type AutomationCatalogGenerationRegistry
} from './automation-host-catalog-generation'
import type {
  AutomationHostCatalog,
  AutomationHostCatalogEntry,
  AutomationHostQuerySupport
} from './automation-host-catalog-types'

const DESKTOP: StableAutomationAuthorityRef = { kind: 'desktop' }
const RUNTIME: StableAutomationAuthorityRef = { kind: 'runtime', environmentId: 'env-1' }
const DESKTOP_SELF: StableAutomationCatalogRef = { authority: DESKTOP, selector: { kind: 'self' } }
const RUNTIME_SELF: StableAutomationCatalogRef = { authority: RUNTIME, selector: { kind: 'self' } }
const RUNTIME_SSH: StableAutomationCatalogRef = {
  authority: RUNTIME,
  selector: { kind: 'ssh', targetId: 'target-1' }
}

function row(id: string): AutomationHostRow {
  return {
    automation: { id, name: id } as Automation,
    owner: null,
    selector: { kind: 'self' },
    usageSummary: null,
    usageKnown: false
  }
}

function createCache(overrides: Parameters<typeof createAutomationHostCache>[0] = {}) {
  return createAutomationHostCache({
    catalogGeneration: () => 0,
    connectionGeneration: () => 0,
    ...overrides
  })
}

describe('automation host cache commit fence', () => {
  it('commits a response whose generations all still match', () => {
    const cache = createCache()
    const fence = cache.beginRequest(DESKTOP_SELF)
    expect(cache.commit(fence, { rows: [row('a')] })).toBe(true)
    expect(cache.get(DESKTOP_SELF)?.data.map((entry) => entry.automation.id)).toEqual(['a'])
  })

  it('discards a response whose entry was invalidated while it was in flight', () => {
    const cache = createCache()
    const fence = cache.beginRequest(DESKTOP_SELF)
    cache.invalidate(DESKTOP_SELF)
    expect(cache.commit(fence, { rows: [row('a')] })).toBe(false)
    expect(cache.get(DESKTOP_SELF)?.data).toEqual([])
  })

  it('discards a response whose authority catalog generation advanced', () => {
    let generation = 7
    const cache = createCache({ catalogGeneration: () => generation })
    const fence = cache.beginRequest(RUNTIME_SSH)
    generation = 8
    expect(cache.commit(fence, { rows: [row('a')] })).toBe(false)
  })

  it('discards a response from a runtime that re-paired mid-flight', () => {
    let revision = 4
    const cache = createCache({ connectionGeneration: () => revision })
    const fence = cache.beginRequest(RUNTIME_SELF)
    revision = 5
    expect(cache.commit(fence, { rows: [row('a')] })).toBe(false)
    expect(
      cache.fail(fence, { code: 'timeout', message: 'x', retryable: true, retryAt: null })
    ).toBe(false)
  })

  // doc:321 — the stable key survives a re-adoption, so the rows have to go.
  it('drops the rows and the in-flight marker of a superseded incarnation', () => {
    const cache = createCache()
    cache.commit(cache.beginRequest(RUNTIME_SSH), { rows: [row('a')], orphanCount: 2 })
    const stale = cache.beginRequest(RUNTIME_SSH)
    cache.trackRequest(stale, Promise.resolve())

    cache.discardIncarnation(hostStableKey(RUNTIME_SSH))

    expect(cache.get(RUNTIME_SSH)?.data).toEqual([])
    expect(cache.freshness(RUNTIME_SSH)).toBe('missing')
    expect(cache.get(RUNTIME_SSH)?.orphanCount).toBeNull()
    expect(cache.pendingRequest(RUNTIME_SSH)).toBeNull()
    expect(cache.commit(stale, { rows: [row('b')] })).toBe(false)
    expect(cache.commit(cache.beginRequest(RUNTIME_SSH), { rows: [row('c')] })).toBe(true)
  })

  it('keeps the last good rows when a refresh fails and clears them on success', () => {
    const cache = createCache()
    cache.commit(cache.beginRequest(DESKTOP_SELF), { rows: [row('a')] })
    const failing = cache.beginRequest(DESKTOP_SELF)
    cache.fail(failing, { code: 'timeout', message: 'slow', retryable: true, retryAt: 100 })
    expect(cache.get(DESKTOP_SELF)?.data).toHaveLength(1)
    expect(cache.get(DESKTOP_SELF)?.attempt).toBe(1)
    cache.commit(cache.beginRequest(DESKTOP_SELF), { rows: [row('a'), row('b')] })
    expect(cache.get(DESKTOP_SELF)?.error).toBeNull()
    expect(cache.get(DESKTOP_SELF)?.attempt).toBe(0)
  })
})

describe('automation host cache freshness and sharing', () => {
  it('reports fresh inside the TTL and stale past it', () => {
    let clock = 1_000
    const cache = createCache({ now: () => clock, ttlMs: 30_000 })
    expect(cache.freshness(DESKTOP_SELF)).toBe('missing')
    cache.commit(cache.beginRequest(DESKTOP_SELF), { rows: [] })
    expect(cache.freshness(DESKTOP_SELF)).toBe('fresh')
    clock += 30_001
    expect(cache.freshness(DESKTOP_SELF)).toBe('stale')
  })

  it('publishes one in-flight request for concurrent callers of the same owner', async () => {
    const cache = createCache()
    const fence = cache.beginRequest(DESKTOP_SELF)
    const request = Promise.resolve()
    cache.trackRequest(fence, request)
    expect(cache.pendingRequest(DESKTOP_SELF)).toBe(request)
    cache.commit(fence, { rows: [] })
    expect(cache.pendingRequest(DESKTOP_SELF)).toBeNull()
  })

  it('refuses to publish an in-flight request against a superseded generation', () => {
    const cache = createCache()
    const fence = cache.beginRequest(DESKTOP_SELF)
    cache.invalidate(DESKTOP_SELF)
    cache.trackRequest(fence, Promise.resolve())
    expect(cache.pendingRequest(DESKTOP_SELF)).toBeNull()
  })
})

describe('automation host cache invalidation scope', () => {
  it('invalidates only the entries of the named authority', () => {
    const cache = createCache()
    cache.commit(cache.beginRequest(DESKTOP_SELF), { rows: [row('a')] })
    const runtimeFence = cache.beginRequest(RUNTIME_SELF)
    cache.commit(runtimeFence, { rows: [row('b')] })
    const desktopFence = cache.beginRequest(DESKTOP_SELF)

    expect(cache.invalidateAuthority(RUNTIME)).toEqual([hostStableKey(RUNTIME_SELF)])
    expect(cache.commit(desktopFence, { rows: [row('c')] })).toBe(true)
  })

  it('drops the payload at retirement, so a revived host refetches over showing old rows', () => {
    const cache = createCache()
    cache.commit(cache.beginRequest(RUNTIME_SELF), { rows: [row('b')], orphanCount: 3 })
    cache.evict(hostStableKey(RUNTIME_SELF))
    cache.beginRequest(RUNTIME_SELF)
    const revived = cache.getByKey(hostStableKey(RUNTIME_SELF))
    expect(revived?.data).toEqual([])
    expect(revived?.fetchedAt).toBeNull()
    expect(revived?.orphanCount).toBeNull()
    expect(cache.freshness(RUNTIME_SELF)).toBe('missing')
  })

  it('evicts a departed entry and caps the retired pool', () => {
    const cache = createCache({ retiredLimit: 1 })
    cache.commit(cache.beginRequest(DESKTOP_SELF), { rows: [row('a')] })
    cache.commit(cache.beginRequest(RUNTIME_SELF), { rows: [row('b')] })
    cache.evict(hostStableKey(DESKTOP_SELF))
    cache.evict(hostStableKey(RUNTIME_SELF))
    expect(cache.keys()).toEqual([])
    // The revived entry keeps its advanced generation, so nothing captured before eviction commits.
    const stale = cache.beginRequest(RUNTIME_SELF)
    cache.invalidate(RUNTIME_SELF)
    expect(cache.commit(stale, { rows: [] })).toBe(false)
  })

  it('notifies subscribers when entries change', () => {
    const cache = createCache()
    const listener = vi.fn()
    const unsubscribe = cache.subscribe(listener)
    cache.commit(cache.beginRequest(DESKTOP_SELF), { rows: [] })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    cache.invalidate(DESKTOP_SELF)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

function catalogEntry(
  ref: StableAutomationCatalogRef,
  querySupport: AutomationHostQuerySupport,
  ownerRevision: number | null
): AutomationHostCatalogEntry {
  return {
    stableRef: ref,
    owner:
      ownerRevision === null
        ? null
        : {
            authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: ownerRevision },
            selector: { kind: 'self' }
          },
    stableKey: hostStableKey(ref),
    label: 'Runtime',
    authorityLabel: 'Runtime',
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'unknown',
    querySupport
  }
}

function catalogOf(entries: AutomationHostCatalogEntry[]): AutomationHostCatalog {
  return {
    entries,
    byStableKey: new Map(entries.map((entry) => [entry.stableKey, entry])),
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

/**
 * The fence is only as stable as the catalog generation feeding it, so this
 * covers Step 2's warning from the consumer's side.
 */
describe('offline authority generation churn', () => {
  const withRegistry = (registry: AutomationCatalogGenerationRegistry) =>
    createAutomationHostCache({
      catalogGeneration: (authority) => registry.get(authority),
      connectionGeneration: () => 0
    })

  it('does not churn while a disconnected authority keeps its last known query support', () => {
    const registry = createAutomationCatalogGenerationRegistry()
    const cache = withRegistry(registry)
    registry.sync(catalogOf([catalogEntry(RUNTIME_SELF, 'scoped', 3)]))
    const fence = cache.beginRequest(RUNTIME_SELF)
    // The authority went offline; membership and incarnation are unchanged.
    registry.sync(catalogOf([catalogEntry(RUNTIME_SELF, 'scoped', 3)]))
    expect(cache.commit(fence, { rows: [row('a')] })).toBe(true)
  })

  it('churns if a disconnect is reported as legacy-unscoped with no owner', () => {
    const registry = createAutomationCatalogGenerationRegistry()
    const cache = withRegistry(registry)
    registry.sync(catalogOf([catalogEntry(RUNTIME_SELF, 'scoped', 3)]))
    const fence = cache.beginRequest(RUNTIME_SELF)
    registry.sync(catalogOf([catalogEntry(RUNTIME_SELF, 'legacy-unscoped', null)]))
    expect(cache.commit(fence, { rows: [row('a')] })).toBe(false)
  })
})
