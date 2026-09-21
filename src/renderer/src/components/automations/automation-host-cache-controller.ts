/**
 * Binds a rebuilt host catalog to the cache, the scheduler, and the authority
 * event stream.
 *
 * The catalog is the only thing that decides what may be fetched: applying one
 * advances the affected authorities' generations first (so anything in flight
 * under the old membership is discarded), evicts entries the catalog no longer
 * lists, and only then asks for what is missing or stale. Authorities that are
 * merely unreachable are left alone — an all-hosts refresh must never dial a
 * connection the user did not ask for.
 */

import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import type { LegacyAutomationPartitionContext } from '../../../../shared/automation-legacy-list-partition'
import type {
  AutomationAuthorityRef,
  StableAutomationAuthorityRef
} from '../../../../shared/automation-owner-ref'
import { syncAutomationHostCatalogGenerations } from './automation-host-catalog-generation'
import type {
  AutomationHostCatalog,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import { createAutomationHostCache, type AutomationHostCache } from './automation-host-cache'
import {
  createAutomationHostInvalidation,
  type AutomationAuthorityChangeEvent,
  type AutomationHostInvalidation
} from './automation-host-invalidation'
import { subscribeAutomationHostInvalidation } from './automation-host-invalidation-window-events'
import {
  createAutomationHostScheduler,
  type AutomationHostFetchTarget,
  type AutomationHostScheduler,
  type AutomationHostSchedulerOptions
} from './automation-host-scheduler'

export type AutomationHostQueryControllerOptions = {
  legacyPartitionContext: (
    authority: StableAutomationAuthorityRef
  ) => LegacyAutomationPartitionContext
  cache?: AutomationHostCache
  scheduler?: AutomationHostScheduler
  transport?: AutomationHostSchedulerOptions['transport']
  now?: () => number
  random?: () => number
  isVisible?: () => boolean
  schedule?: (flush: () => void) => void
  scheduleRetry?: AutomationHostSchedulerOptions['scheduleRetry']
  /** Where `automationsChanged` arrives; `null` opts out for a caller that feeds events itself. */
  eventTarget?: EventTarget | null
  /** Notified after each committed refresh cycle so a view can re-render. */
  onSettled?: () => void
}

export type AutomationHostApplyCatalogOptions = {
  /** The host the user is looking at; it and Desktop + Self jump the queue. */
  selectedStableKey?: string | null
  /** Manual refresh: bypasses TTL for the authorities that are reachable. */
  force?: boolean
}

export type AutomationHostQueryController = {
  cache: AutomationHostCache
  scheduler: AutomationHostScheduler
  applyCatalog: (
    catalog: AutomationHostCatalog,
    options?: AutomationHostApplyCatalogOptions
  ) => Promise<void>
  /** Feeds one `automationsChanged` event in; bursts coalesce into one refresh. */
  handleAuthorityEvent: (event: AutomationAuthorityChangeEvent) => void
  /** Latest orphan count the authority reported, so the next catalog can show its orphan entry. */
  authorityOrphanCount: (authority: StableAutomationAuthorityRef) => number | null
  /** True once disposed. A disposed controller drops every event and refresh, so a mounted owner must replace it. */
  isDisposed: () => boolean
  dispose: () => void
}

function authorityRefFor(entry: AutomationHostCatalogEntry): AutomationAuthorityRef {
  if (entry.owner) {
    return entry.owner.authority
  }
  const authority = entry.stableRef.authority
  return authority.kind === 'desktop'
    ? { kind: 'desktop' }
    : {
        kind: 'runtime',
        environmentId: authority.environmentId,
        // Why: an unmirrored environment must fail the fence rather than borrow revision 0.
        pairingRevision: getRuntimeEnvironmentRevision(authority.environmentId) ?? -1
      }
}

function isFetchable(entry: AutomationHostCatalogEntry, selectedStableKey: string | null): boolean {
  if (entry.catalogState === 'removed') {
    return false
  }
  // A disconnected authority proves nothing about its rows, so it keeps the stale ones
  // and a Reconnect action instead of being dialled by a background refresh.
  return entry.authorityHealth !== 'unavailable' || entry.stableKey === selectedStableKey
}

function toFetchTarget(
  entry: AutomationHostCatalogEntry,
  selectedStableKey: string | null
): AutomationHostFetchTarget {
  return {
    ref: entry.stableRef,
    authority: authorityRefFor(entry),
    owner: entry.owner,
    querySupport: entry.querySupport,
    priority:
      entry.stableKey === selectedStableKey ||
      (entry.stableRef.authority.kind === 'desktop' && entry.stableRef.selector.kind === 'self')
  }
}

export function createAutomationHostQueryController(
  options: AutomationHostQueryControllerOptions
): AutomationHostQueryController {
  const cache = options.cache ?? createAutomationHostCache({ now: options.now })
  const scheduler =
    options.scheduler ??
    createAutomationHostScheduler({
      cache,
      legacyPartitionContext: options.legacyPartitionContext,
      transport: options.transport,
      now: options.now,
      random: options.random,
      isVisible: options.isVisible,
      scheduleRetry: options.scheduleRetry
    })
  let latest: AutomationHostCatalog | null = null
  let selected: string | null = null
  let disposed = false

  const targetsFor = (
    catalog: AutomationHostCatalog,
    include?: (entry: AutomationHostCatalogEntry) => boolean
  ): AutomationHostFetchTarget[] =>
    catalog.entries
      .filter((entry) => isFetchable(entry, selected) && (include?.(entry) ?? true))
      .map((entry) => toFetchTarget(entry, selected))

  const refreshKeys = async (stableKeys: readonly string[]): Promise<void> => {
    const catalog = latest
    if (!catalog) {
      return
    }
    const wanted = new Set(stableKeys)
    const targets = targetsFor(catalog, (entry) => wanted.has(entry.stableKey))
    if (targets.length > 0) {
      // Forced: the event already proved these entries stale, so TTL must not swallow them.
      await scheduler.refresh(targets, { force: true })
      options.onSettled?.()
    }
  }

  const invalidation: AutomationHostInvalidation = createAutomationHostInvalidation({
    cache,
    schedule: options.schedule,
    onInvalidated: (stableKeys) => {
      void refreshKeys(stableKeys)
    }
  })

  // Subscribed here by default: an unsubscribed controller silently stops
  // refreshing on writes, which looks like stale data, not a missing wire. A
  // caller that opts out with `eventTarget: null` (the React hook, whose
  // StrictMode-safe lifecycle owns the subscription) takes that duty on itself.
  const eventTarget =
    options.eventTarget === undefined ? (globalThis.window ?? null) : options.eventTarget
  const unsubscribe = eventTarget
    ? subscribeAutomationHostInvalidation(invalidation.handle, eventTarget)
    : null

  return {
    cache,
    scheduler,
    applyCatalog: async (catalog, applyOptions = {}) => {
      latest = catalog
      selected = applyOptions.selectedStableKey ?? null
      // Membership first: a request captured under the old membership must not commit.
      const generations = syncAutomationHostCatalogGenerations(catalog)
      // A re-adopted host keeps its stable key, so eviction below never sees it:
      // only this drops rows the host's previous incarnation answered with.
      for (const stableKey of generations.reincarnatedStableKeys) {
        cache.discardIncarnation(stableKey)
      }
      for (const key of cache.keys()) {
        if (!catalog.byStableKey.has(key)) {
          cache.evict(key)
        }
      }
      scheduler.cancelQueued()
      const manual = applyOptions.force === true
      // A manual refresh bypasses TTL, but a host already known to fail stays failed
      // with its own Retry rather than being dialled again by the all-hosts button.
      await scheduler.refresh(targetsFor(catalog), {
        force: manual,
        skipKnownFailures: manual
      })
      options.onSettled?.()
    },
    handleAuthorityEvent: invalidation.handle,
    authorityOrphanCount: (authority) => {
      let newest: { fetchedAt: number; orphanCount: number } | null = null
      for (const key of cache.keysForAuthority(authority)) {
        const entry = cache.getByKey(key)
        if (!entry || entry.orphanCount === null || entry.fetchedAt === null) {
          continue
        }
        if (!newest || entry.fetchedAt >= newest.fetchedAt) {
          newest = { fetchedAt: entry.fetchedAt, orphanCount: entry.orphanCount }
        }
      }
      return newest?.orphanCount ?? null
    },
    isDisposed: () => disposed,
    dispose: () => {
      disposed = true
      unsubscribe?.()
      invalidation.dispose()
      scheduler.dispose()
    }
  }
}
