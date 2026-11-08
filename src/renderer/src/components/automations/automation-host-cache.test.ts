/** A formerly correct answer can arrive after host replacement; the commit fence must reject it instead of misattributing automations. */

import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../shared/automations/automation-definition'
import { hostStableKey } from '../../../../shared/automations/ownership/automation-owner-key'
import type {
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automations/ownership/automation-owner-ref'
import { createAutomationHostCache } from './automation-host-cache'
import type { AutomationHostRow } from './automation-host-cache-types'

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
})

describe('automation host cache freshness and sharing', () => {
  it('refuses to publish an in-flight request against a superseded generation', () => {
    const cache = createCache()
    const fence = cache.beginRequest(DESKTOP_SELF)
    cache.invalidate(DESKTOP_SELF)
    cache.trackRequest(fence, Promise.resolve())
    expect(cache.pendingRequest(DESKTOP_SELF)).toBeNull()
  })
})

describe('automation host cache invalidation scope', () => {
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

  it('evicts departed entries and rejects work captured before retirement', () => {
    const cache = createCache({ retiredLimit: 1 })
    cache.commit(cache.beginRequest(DESKTOP_SELF), { rows: [row('a')] })
    cache.commit(cache.beginRequest(RUNTIME_SELF), { rows: [row('b')] })
    const stale = cache.beginRequest(RUNTIME_SELF)
    cache.evict(hostStableKey(DESKTOP_SELF))
    cache.evict(hostStableKey(RUNTIME_SELF))
    expect(cache.keys()).toEqual([])
    cache.beginRequest(RUNTIME_SELF)
    expect(cache.commit(stale, { rows: [] })).toBe(false)
  })
})

/** Verify offline catalog changes do not invalidate requests through spurious generation churn. */
