import type { StoreApi } from 'zustand'
import type { AppState } from '../../types'
import { runtimeStatusSubscriptionsFor } from '../../slices/runtime-status/views/runtime-status-subscriptions'
import { GitHubSourceCollections } from './source-collections'

/** Keeps collection owners in step with repo rows and host connections for the store's lifetime. */
export function createGitHubSourceCollections(store: StoreApi<AppState>) {
  const cache = new GitHubSourceCollections(store)
  let stopStatuses: (() => void) | null = null
  store.subscribe((state, previous) => {
    // Joined on the first write: the store has no state while its slices are created.
    const firstWrite = stopStatuses === null
    stopStatuses ??= runtimeStatusSubscriptionsFor(store).subscribeStatuses(() =>
      cache.sync(store.getState().repos ?? [])
    )
    if (
      firstWrite ||
      state.repos !== previous.repos ||
      state.runtimeEnvironments !== previous.runtimeEnvironments ||
      state.sshConnectionStates !== previous.sshConnectionStates ||
      state.sshStateByEnvironment !== previous.sshStateByEnvironment
    ) {
      cache.sync(state.repos ?? [])
    }
  })
  return cache
}
