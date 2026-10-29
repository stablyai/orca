/** Apply catalog membership/incarnation generations before fetching, discard stale work and evict missing entries. Background All-hosts refresh preserves unreachable authorities without dialing them. */

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
  // Preserve stale rows/Reconnect for disconnected authorities; only explicit selection may ask them again.
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

  // Subscribe by default so writes refresh rows; eventTarget:null transfers subscription duty to the caller’s StrictMode-safe lifecycle.
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
      // Re-adoption preserves stable keys, so explicitly discard the prior incarnation’s cached rows.
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
      // Manual refresh bypasses TTL but leaves known failures to their own Retry.
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
