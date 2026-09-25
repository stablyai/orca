import {
  ALL_AUTOMATION_HOSTS_FILTER,
  automationHostFilterStableKey,
  type AutomationHostFilter
} from '../../../../shared/automation-host-filter'
import type { StableAutomationCatalogRef } from '../../../../shared/automation-owner-ref'
import {
  automationAuthorityCatalogKey,
  type AutomationCatalogHydrationEvidence,
  type AutomationHostCatalog,
  type AutomationHostCatalogEntry
} from './automation-host-catalog-types'

/**
 * Restores a persisted host selection against the live catalog.
 *
 * The rule that makes this non-trivial: missing catalog data is never evidence
 * of removal (required invariant 4). Until the relevant catalog settles the
 * selection is retained and reported as `loading`; only positive evidence —
 * a hydrated target list, a settled runtime catalog, or a tombstone — may drop it.
 */

export type AutomationHostFilterStatus =
  | 'all'
  /** The selected host is present and authoritative. */
  | 'ready'
  /** Relevant state is unhydrated. Retain the selection and show `Loading host…`. */
  | 'loading'
  /** The owning authority is offline, so absence proves nothing. Retain. */
  | 'unavailable'
  /** Positively removed but still referenced by automations or cached rows. Retain as a ghost. */
  | 'ghost'
  /** Positively removed and unreferenced: fall back to All hosts and announce it. */
  | 'removed'

export type AutomationHostFilterResolution = {
  /** What the list should actually render and query. */
  effective: AutomationHostFilter
  entry: AutomationHostCatalogEntry | null
  status: AutomationHostFilterStatus
  /** True only when a saved selection was dropped; the change must be announced. */
  announceFallback: boolean
}

export type AutomationHostFilterResolutionInput = {
  filter: AutomationHostFilter
  catalog: AutomationHostCatalog
  /** Stable keys still referenced by a stored automation or cached row, tombstones aside. */
  referencedStableKeys?: ReadonlySet<string>
}

const ALL_RESOLUTION: AutomationHostFilterResolution = {
  effective: ALL_AUTOMATION_HOSTS_FILTER,
  entry: null,
  status: 'all',
  announceFallback: false
}

function retain(
  filter: AutomationHostFilter,
  entry: AutomationHostCatalogEntry | null,
  status: AutomationHostFilterStatus
): AutomationHostFilterResolution {
  return { effective: filter, entry, status, announceFallback: false }
}

function fallBackToAllHosts(): AutomationHostFilterResolution {
  return {
    effective: ALL_AUTOMATION_HOSTS_FILTER,
    entry: null,
    status: 'removed',
    announceFallback: true
  }
}

function resolvePresentEntry(
  filter: AutomationHostFilter,
  entry: AutomationHostCatalogEntry,
  referenced: boolean
): AutomationHostFilterResolution {
  if (entry.authorityHealth === 'unavailable') {
    // Why: an offline authority can neither confirm removal nor prove an orphan was repaired.
    return retain(filter, entry, 'unavailable')
  }
  if (entry.catalogState === 'unhydrated') {
    return retain(filter, entry, 'loading')
  }
  if (entry.catalogState === 'removed') {
    return referenced ? retain(filter, entry, 'ghost') : fallBackToAllHosts()
  }
  return retain(filter, entry, 'ready')
}

/** Positive-evidence gate for a selection that has no catalog entry at all. */
function resolveAbsentEntry(
  filter: AutomationHostFilter,
  host: StableAutomationCatalogRef,
  hydration: AutomationCatalogHydrationEvidence
): AutomationHostFilterResolution {
  const authorityKey = automationAuthorityCatalogKey(host.authority)
  if (hydration.unavailableAuthorityKeys.has(authorityKey)) {
    return retain(filter, null, 'unavailable')
  }
  if (host.authority.kind === 'runtime') {
    const environmentId = host.authority.environmentId
    if (!hydration.savedRuntimeEnvironmentIds.has(environmentId)) {
      // The whole authority is gone — only a settled saved-runtime catalog proves that.
      return hydration.runtimeCatalogSettled
        ? fallBackToAllHosts()
        : retain(filter, null, 'loading')
    }
  }
  if (host.selector.kind === 'self') {
    // Desktop Self and every saved runtime's Self are always projected, so an
    // absent one means the saved catalog has not produced it yet.
    return retain(filter, null, 'loading')
  }
  if (host.selector.kind === 'orphan') {
    return hydration.orphanSettledAuthorityKeys.has(authorityKey)
      ? fallBackToAllHosts()
      : retain(filter, null, 'loading')
  }
  const sshHydrated =
    host.authority.kind === 'desktop'
      ? hydration.desktopSshHydrated
      : (hydration.runtimeSshHydratedByEnvironmentId.get(host.authority.environmentId) ?? false)
  return sshHydrated ? fallBackToAllHosts() : retain(filter, null, 'loading')
}

export function resolveAutomationHostFilter(
  input: AutomationHostFilterResolutionInput
): AutomationHostFilterResolution {
  const stableKey = automationHostFilterStableKey(input.filter)
  if (input.filter.kind === 'all' || stableKey === null) {
    return ALL_RESOLUTION
  }
  const entry = input.catalog.byStableKey.get(stableKey)
  return entry
    ? resolvePresentEntry(input.filter, entry, input.referencedStableKeys?.has(stableKey) ?? false)
    : resolveAbsentEntry(input.filter, input.filter.host, input.catalog.hydration)
}
