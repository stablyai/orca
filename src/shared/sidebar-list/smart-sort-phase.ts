import type { WorkspaceSortBy } from '../workspace-view/workspace-row-sort'

/**
 * Smart's cold start. Agent status hydrates after the list mounts, so until the list has seen a
 * live signal Smart keeps the persisted order and never writes it back. Once latched, Smart stays
 * live for the list's lifetime, even after that activity ends.
 */
export type SmartSortPhase = 'cold' | 'live'

/** Null outside Smart. */
export function smartSortPhase(sortBy: WorkspaceSortBy, latched: boolean): SmartSortPhase | null {
  if (sortBy !== 'smart') {
    return null
  }
  return latched ? 'live' : 'cold'
}

/** Manual and cold Smart rank by persisted order, so they follow another client's save. */
export function ranksFollowPersistedOrder(sortBy: WorkspaceSortBy, latched: boolean): boolean {
  return sortBy === 'manual' || smartSortPhase(sortBy, latched) === 'cold'
}
