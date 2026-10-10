/**
 * Folds query results back onto the catalog for display.
 *
 * Kept separate from the catalog the controller is given: this one changes on
 * every commit, and re-applying a catalog advances generations and cancels
 * in-flight requests. The picker, notice, and empty state read this projection;
 * the scheduler reads the store-derived one.
 */

import type { AutomationHostCache } from './automation-host-cache'
import type {
  AutomationHostCacheEntry,
  AutomationHostQueryErrorCode
} from './automation-host-cache-types'
import type {
  AutomationAuthorityHealth,
  AutomationHostCatalog,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'

export type AutomationHostLoadCounts = {
  failedHostCount: number
  totalHostCount: number
}

export type AutomationHostHealthInput = {
  entry: (stableKey: string) => AutomationHostCacheEntry | null
  /**
   * Authorities whose most recent list attempt failed outside the per-host
   * cache — today the page's own unscoped refresh. Without this a failed load
   * would render as an empty host, which claims we looked and found nothing.
   */
  failedAuthorityKeys?: ReadonlySet<string>
}

const ERROR_HEALTH: Partial<Record<AutomationHostQueryErrorCode, AutomationAuthorityHealth>> = {
  authority_unavailable: 'unavailable',
  incompatible: 'incompatible'
}

function healthFromCache(
  cached: AutomationHostCacheEntry | null
): AutomationAuthorityHealth | null {
  if (!cached) {
    return null
  }
  if (cached.error) {
    return ERROR_HEALTH[cached.error.code] ?? 'stale-error'
  }
  if (cached.request) {
    return cached.fetchedAt === null ? 'loading' : 'refreshing'
  }
  return cached.fetchedAt === null ? null : 'fresh'
}

export function automationHostEntryHealth(
  entry: AutomationHostCatalogEntry,
  input: AutomationHostHealthInput
): AutomationAuthorityHealth {
  // An offline authority already outranks anything its cache entry could say.
  if (entry.authorityHealth === 'unavailable' || entry.authorityHealth === 'incompatible') {
    return entry.authorityHealth
  }
  const fromCache = healthFromCache(input.entry(entry.stableKey))
  if (fromCache) {
    return fromCache
  }
  const authorityKey = automationAuthorityCatalogKey(entry.stableRef.authority)
  if (input.failedAuthorityKeys?.has(authorityKey)) {
    return 'stale-error'
  }
  return entry.authorityHealth
}

/** Returns the same catalog object when no entry's health moved, so memos hold. */
export function withAutomationHostCacheHealth(
  catalog: AutomationHostCatalog,
  input: AutomationHostHealthInput
): AutomationHostCatalog {
  let changed = false
  const entries = catalog.entries.map((entry) => {
    const authorityHealth = automationHostEntryHealth(entry, input)
    if (authorityHealth === entry.authorityHealth) {
      return entry
    }
    changed = true
    return { ...entry, authorityHealth }
  })
  if (!changed) {
    return catalog
  }
  return {
    entries,
    byStableKey: new Map(entries.map((entry) => [entry.stableKey, entry])),
    hydration: {
      ...catalog.hydration,
      unavailableAuthorityKeys: new Set([
        ...catalog.hydration.unavailableAuthorityKeys,
        ...entries
          .filter((entry) => entry.authorityHealth === 'unavailable')
          .map((entry) => automationAuthorityCatalogKey(entry.stableRef.authority))
      ])
    }
  }
}

const FAILED_HEALTH: ReadonlySet<AutomationAuthorityHealth> = new Set([
  'unavailable',
  'stale-error',
  'incompatible'
])

/**
 * Counts hosts, not authorities: the summary tells the user how much of the
 * list is missing, and one unreachable server can account for several hosts.
 * Removed entries are excluded — a ghost was never expected to load.
 */
export function automationHostLoadCounts(catalog: AutomationHostCatalog): AutomationHostLoadCounts {
  const counted = catalog.entries.filter((entry) => entry.catalogState !== 'removed')
  return {
    failedHostCount: counted.filter((entry) => FAILED_HEALTH.has(entry.authorityHealth)).length,
    totalHostCount: counted.length
  }
}

/** Adapter so callers can pass a live cache where a plain reader is expected. */
export function automationHostCacheReader(
  cache: AutomationHostCache
): (stableKey: string) => AutomationHostCacheEntry | null {
  return (stableKey) => cache.getByKey(stableKey)
}
