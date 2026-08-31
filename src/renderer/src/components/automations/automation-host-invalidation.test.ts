/**
 * Event invalidation has one blast-radius rule: a scoped event touches its own
 * entry, an unscoped one touches its authority, and neither ever touches
 * another authority's rows.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import type {
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import { createAutomationHostCache, type AutomationHostCache } from './automation-host-cache'
import type { AutomationHostRow } from './automation-host-cache-types'
import { createAutomationHostInvalidation } from './automation-host-invalidation'

const DESKTOP: StableAutomationAuthorityRef = { kind: 'desktop' }
const RUNTIME: StableAutomationAuthorityRef = { kind: 'runtime', environmentId: 'env-1' }
const DESKTOP_SELF: StableAutomationCatalogRef = { authority: DESKTOP, selector: { kind: 'self' } }
const DESKTOP_SSH: StableAutomationCatalogRef = {
  authority: DESKTOP,
  selector: { kind: 'ssh', targetId: 'target-1' }
}
const RUNTIME_SELF: StableAutomationCatalogRef = { authority: RUNTIME, selector: { kind: 'self' } }

function row(id: string): AutomationHostRow {
  return {
    automation: { id } as Automation,
    owner: null,
    selector: { kind: 'self' },
    usageSummary: null,
    usageKnown: false
  }
}

function seeded(): AutomationHostCache {
  const cache = createAutomationHostCache({
    catalogGeneration: () => 0,
    connectionGeneration: () => 0
  })
  for (const ref of [DESKTOP_SELF, DESKTOP_SSH, RUNTIME_SELF]) {
    cache.commit(cache.beginRequest(ref), { rows: [row('a')] })
  }
  return cache
}

function generationOf(cache: AutomationHostCache, ref: StableAutomationCatalogRef): number {
  return cache.get(ref)?.requestGeneration ?? -1
}

describe('automation host invalidation', () => {
  it('invalidates only the entry a scoped event names', () => {
    const cache = seeded()
    const onInvalidated = vi.fn()
    const invalidation = createAutomationHostInvalidation({
      cache,
      onInvalidated,
      schedule: (f) => f()
    })
    const before = generationOf(cache, DESKTOP_SELF)

    invalidation.handle({ authority: DESKTOP, selector: { kind: 'ssh', targetId: 'target-1' } })

    expect(onInvalidated).toHaveBeenCalledWith([hostStableKey(DESKTOP_SSH)])
    expect(generationOf(cache, DESKTOP_SELF)).toBe(before)
  })

  it('invalidates every entry of one authority for an unscoped event, and no other authority', () => {
    const cache = seeded()
    const onInvalidated = vi.fn()
    const invalidation = createAutomationHostInvalidation({
      cache,
      onInvalidated,
      schedule: (f) => f()
    })
    const untouched = generationOf(cache, RUNTIME_SELF)

    invalidation.handle({ authority: DESKTOP, reason: 'definition' })

    expect(onInvalidated.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([hostStableKey(DESKTOP_SELF), hostStableKey(DESKTOP_SSH)])
    )
    expect(onInvalidated.mock.calls[0]?.[0]).not.toContain(hostStableKey(RUNTIME_SELF))
    expect(generationOf(cache, RUNTIME_SELF)).toBe(untouched)
  })

  it('coalesces a burst into one invalidation pass', async () => {
    const cache = seeded()
    const onInvalidated = vi.fn()
    const invalidation = createAutomationHostInvalidation({ cache, onInvalidated })

    invalidation.handle({ authority: DESKTOP, selector: { kind: 'self' }, reason: 'definition' })
    invalidation.handle({ authority: DESKTOP, selector: { kind: 'self' }, reason: 'run' })
    invalidation.handle({ authority: DESKTOP, selector: { kind: 'ssh', targetId: 'target-1' } })
    expect(invalidation.pending()).toBe(2)
    expect(onInvalidated).not.toHaveBeenCalled()

    await Promise.resolve()
    expect(onInvalidated).toHaveBeenCalledTimes(1)
    expect(onInvalidated.mock.calls[0]?.[0]).toHaveLength(2)
    // Why: one refresh per burst, so an entry's generation advances once, not three times.
    expect(generationOf(cache, DESKTOP_SELF)).toBe(1)
  })

  it('folds a scoped event into the authority pass it is already covered by', async () => {
    const cache = seeded()
    const onInvalidated = vi.fn()
    const invalidation = createAutomationHostInvalidation({ cache, onInvalidated })

    invalidation.handle({ authority: DESKTOP })
    invalidation.handle({ authority: DESKTOP, selector: { kind: 'self' } })
    await Promise.resolve()

    expect(onInvalidated.mock.calls[0]?.[0]).toHaveLength(2)
    expect(generationOf(cache, DESKTOP_SELF)).toBe(1)
  })

  it('reports a scoped event for a host nothing is caching yet', async () => {
    const cache = seeded()
    const uncached: StableAutomationCatalogRef = {
      authority: RUNTIME,
      selector: { kind: 'ssh', targetId: 'never-seen' }
    }
    const onInvalidated = vi.fn()
    const invalidation = createAutomationHostInvalidation({ cache, onInvalidated })

    // A create is the first thing that ever addresses its host: dropping the key
    // for want of a stale entry is how the new row never appears.
    invalidation.handle({ authority: RUNTIME, selector: { kind: 'ssh', targetId: 'never-seen' } })
    await Promise.resolve()

    expect(onInvalidated).toHaveBeenCalledWith([hostStableKey(uncached)])
    expect(cache.get(uncached)).toBeNull()
    expect(generationOf(cache, RUNTIME_SELF)).toBe(0)
  })

  it('drops queued work once disposed', async () => {
    const cache = seeded()
    const onInvalidated = vi.fn()
    const invalidation = createAutomationHostInvalidation({ cache, onInvalidated })
    invalidation.handle({ authority: DESKTOP })
    invalidation.dispose()
    await Promise.resolve()
    expect(onInvalidated).not.toHaveBeenCalled()
  })
})
