import type { StoreApi } from 'zustand'
import type { AppState } from '../../types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/rpc/targets/runtime-client-target'
import { runtimeStatusSubscriptionsFor } from '../../slices/runtime-status/views/runtime-status-subscriptions'
import { GitHubSourceCollections } from './source-collections'

const reposByEnvironmentCache = new WeakMap<readonly Repo[], Map<string, Repo[]>>()

/** Repo rows by the paired runtime that routes to them, nested SSH included. */
function reposByEnvironment(repos: readonly Repo[]): Map<string, Repo[]> {
  let byEnvironment = reposByEnvironmentCache.get(repos)
  if (!byEnvironment) {
    byEnvironment = new Map()
    for (const repo of repos) {
      const target = runtimeRpcTargetForAuthorityKey(getRepoExecutionHostId(repo))
      if (target?.kind === 'environment') {
        const onEnvironment = byEnvironment.get(target.environmentId) ?? []
        onEnvironment.push(repo)
        byEnvironment.set(target.environmentId, onEnvironment)
      }
    }
    reposByEnvironmentCache.set(repos, byEnvironment)
  }
  return byEnvironment
}

/** Keeps collection owners in step with repo rows and host connections for the store's lifetime. */
export function createGitHubSourceCollections(store: StoreApi<AppState>) {
  const cache = new GitHubSourceCollections(store)
  // A status write moves only its hosts' connection fences, so it re-captures just their owners.
  runtimeStatusSubscriptionsFor(store).subscribeStatusChanges((change) => {
    const byEnvironment = reposByEnvironment(store.getState().repos ?? [])
    const touched = [...change.ids].flatMap((id) => byEnvironment.get(id) ?? [])
    if (touched.length > 0) {
      cache.syncHostRepos(touched)
    }
  })
  store.subscribe((state, previous) => {
    if (
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
