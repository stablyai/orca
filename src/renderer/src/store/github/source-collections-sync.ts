import type { StoreApi } from 'zustand'
import type { AppState } from '../types'
import { GitHubSourceCollections } from './source-collections'

/** Keeps collection owners in step with repo rows and host connections for the store's lifetime. */
export function createGitHubSourceCollections(store: StoreApi<AppState>) {
  const cache = new GitHubSourceCollections(store)
  store.subscribe((state, previous) => {
    if (
      state.repos !== previous.repos ||
      state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId ||
      state.runtimeEnvironments !== previous.runtimeEnvironments ||
      state.sshConnectionStates !== previous.sshConnectionStates ||
      state.sshStateByEnvironment !== previous.sshStateByEnvironment
    ) {
      cache.sync(state.repos ?? [])
    }
  })
  return cache
}
