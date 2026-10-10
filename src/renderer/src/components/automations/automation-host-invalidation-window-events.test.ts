/**
 * The window event is the only place the publisher's identity can be lost, so
 * these cover the whole attribution path: a scoped runtime event must reach one
 * host, and an unattributed one must still reach a whole authority.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import type {
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import {
  AUTOMATIONS_CHANGED_EVENT,
  emitAutomationsChangedWindowEvent
} from '@/lib/automations-changed-window-event'
import { createAutomationHostCache, type AutomationHostCache } from './automation-host-cache'
import type { AutomationHostRow } from './automation-host-cache-types'
import { createAutomationHostInvalidation } from './automation-host-invalidation'
import {
  subscribeAutomationHostInvalidation,
  toAutomationAuthorityChangeEvent
} from './automation-host-invalidation-window-events'

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
  for (const ref of [DESKTOP_SELF, RUNTIME_SELF, RUNTIME_SSH]) {
    cache.commit(cache.beginRequest(ref), { rows: [row('a')] })
  }
  return cache
}

function subscribedCache(): { cache: AutomationHostCache; invalidated: ReturnType<typeof vi.fn> } {
  const cache = seeded()
  const invalidated = vi.fn()
  const invalidation = createAutomationHostInvalidation({
    cache,
    onInvalidated: invalidated,
    schedule: (flush) => flush()
  })
  subscribeAutomationHostInvalidation(invalidation.handle)
  return { cache, invalidated }
}

describe('automationsChanged window event attribution', () => {
  // The suite runs in node, so the publisher and the subscriber need a real shared target.
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget())
  })

  it('maps an environment id to its runtime authority and keeps the selector', () => {
    expect(
      toAutomationAuthorityChangeEvent({
        environmentId: 'env-1',
        selector: { kind: 'ssh', targetId: 'target-1' },
        reason: 'definition'
      })
    ).toEqual({
      authority: RUNTIME,
      selector: { kind: 'ssh', targetId: 'target-1' },
      reason: 'definition'
    })
  })

  it('treats an absent environment id as the desktop authority', () => {
    expect(toAutomationAuthorityChangeEvent({ reason: 'run' })).toEqual({
      authority: DESKTOP,
      reason: 'run'
    })
  })

  it('routes a scoped runtime event to one host and leaves the others alone', () => {
    const { cache, invalidated } = subscribedCache()

    emitAutomationsChangedWindowEvent({
      environmentId: 'env-1',
      selector: { kind: 'ssh', targetId: 'target-1' },
      reason: 'definition'
    })

    expect(invalidated).toHaveBeenCalledWith([hostStableKey(RUNTIME_SSH)])
    expect(cache.get(RUNTIME_SELF)?.requestGeneration).toBe(0)
    expect(cache.get(DESKTOP_SELF)?.requestGeneration).toBe(0)
  })

  it('falls back to the whole authority when an old host sends no selector', () => {
    const { cache, invalidated } = subscribedCache()

    emitAutomationsChangedWindowEvent({ environmentId: 'env-1' })

    expect(invalidated.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([hostStableKey(RUNTIME_SELF), hostStableKey(RUNTIME_SSH)])
    )
    expect(cache.get(DESKTOP_SELF)?.requestGeneration).toBe(0)
  })

  // A publisher that predates the detail payload still has to produce a refresh.
  it('degrades a bare Event to an unscoped desktop invalidation', () => {
    const { cache, invalidated } = subscribedCache()

    window.dispatchEvent(new Event(AUTOMATIONS_CHANGED_EVENT))

    expect(invalidated).toHaveBeenCalledWith([hostStableKey(DESKTOP_SELF)])
    expect(cache.get(RUNTIME_SELF)?.requestGeneration).toBe(0)
  })

  it('stops delivering once unsubscribed', () => {
    const cache = seeded()
    const invalidated = vi.fn()
    const invalidation = createAutomationHostInvalidation({
      cache,
      onInvalidated: invalidated,
      schedule: (flush) => flush()
    })
    const unsubscribe = subscribeAutomationHostInvalidation(invalidation.handle)

    unsubscribe()
    emitAutomationsChangedWindowEvent({ environmentId: 'env-1' })

    expect(invalidated).not.toHaveBeenCalled()
  })
})
