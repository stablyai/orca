import type { WorkspaceSortBy } from '../workspace-view/workspace-row-sort'

/** Keep persisted order without writing during async hydration; latch live Smart for the list lifetime after its first signal. */
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
