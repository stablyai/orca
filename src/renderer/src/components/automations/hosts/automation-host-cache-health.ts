/** Project query health separately from the scheduler’s store-derived catalog; feeding every cache commit back into it would advance generations and cancel pending work. */

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
  /** Include failures outside the per-host cache so an unscoped read failure cannot appear as an answered empty host. */
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

/** Count missing hosts rather than authorities; exclude removed entries that were never expected to load. */
export function automationHostLoadCounts(catalog: AutomationHostCatalog): AutomationHostLoadCounts {
  const counted = catalog.entries.filter((entry) => entry.catalogState !== 'removed')
  return {
    failedHostCount: counted.filter((entry) => FAILED_HEALTH.has(entry.authorityHealth)).length,
    totalHostCount: counted.length
  }
}
