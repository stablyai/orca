// Rows seeded from a WSL host's saved project list, and the hosts whose live list already applied.
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'

const savedRows = new WeakSet<Repo>()
const liveListHostsByStore = new WeakMap<() => AppState, Set<string>>()

export function markSavedHostCatalogRow(repo: Repo): void {
  savedRows.add(repo)
}

/** Any live answer may drop a saved row, even one requested before the seed landed. */
export function isSavedHostCatalogRow(repo: Repo): boolean {
  return savedRows.has(repo)
}

export function noteLiveRepoCatalogApplied(get: () => AppState, hostId: string): void {
  let hosts = liveListHostsByStore.get(get)
  if (!hosts) {
    hosts = new Set()
    liveListHostsByStore.set(get, hosts)
  }
  hosts.add(hostId)
}

/** A seed landing after the host's live list must not bring back what that list dropped. */
export function hasLiveRepoCatalogApplied(get: () => AppState, hostId: string): boolean {
  return liveListHostsByStore.get(get)?.has(hostId) === true
}
