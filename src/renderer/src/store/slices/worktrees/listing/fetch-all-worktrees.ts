import type { WorktreeSlice } from '../../worktree-helpers'
import { isStaleWorktreeCatalogPublication } from './worktree-catalog-version-state'
import type { WorktreeSliceGet, WorktreeSliceSet } from './worktree-slice-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import { getCurrentDirectSshAuthority } from './direct-ssh-authority'
import { listDetectedWorktreesForRepoCoalesced } from './detected-worktree-refresh'
import {
  getKnownWorktreeIdsForPurge,
  getProjectHostSetupForRepoHost
} from './worktree-host-ownership'
import { fetchKnownSshWorktreesForRepo } from './known-ssh-worktree-fetch'
import { mergeFetchedWorktrees } from './fetched-worktree-merge'
import { notifyRuntimeScopeForbiddenIfNeeded } from './runtime-scope-forbidden-toast'
import { mapReposForWorktreeRefresh } from './worktree-refresh-pool'
import { selectWorktreesByRepo } from '../../../workspace-record-selectors'
import { purgeHydratedWorktrees } from './hydrated-worktree-purge'
import type { WorktreeRefreshResult } from './worktree-refresh-result'

export function createFetchAllWorktrees(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['fetchAllWorktrees'] {
  return async (options) => {
    const repos = options?.visibilityOwnerHostId
      ? get().repos.filter((repo) => {
          const repoHost = parseExecutionHostId(getRepoExecutionHostId(repo))
          const ownerHost = parseExecutionHostId(options.visibilityOwnerHostId)
          return ownerHost?.kind === 'runtime'
            ? repoHost?.kind === 'runtime' && repoHost.environmentId === ownerHost.environmentId
            : repoHost?.kind !== 'runtime'
        })
      : get().repos
    const purgeRemovedWorktrees = get().hasHydratedWorktreePurge || !!options?.visibilityOwnerHostId
    const results = await mapReposForWorktreeRefresh(
      repos,
      async (repo): Promise<WorktreeRefreshResult> => {
        const hostId = getRepoExecutionHostId(repo)
        const failed = { repoId: repo.id, hostId, refresh: null }
        try {
          const requestStartedState = get()
          const requestStartedWorktrees = selectWorktreesByRepo(requestStartedState)[repo.id]
          const setup = getProjectHostSetupForRepoHost(requestStartedState, repo.id, hostId)
          const parsedHost = parseExecutionHostId(hostId)
          const directSshAuthority =
            parsedHost?.kind === 'ssh'
              ? (getCurrentDirectSshAuthority(requestStartedState, hostId) ?? undefined)
              : undefined
          if (parsedHost?.kind === 'ssh' && !directSshAuthority) {
            await fetchKnownSshWorktreesForRepo(set, repo.id, parsedHost.id)
            return failed
          }
          const refresh = await listDetectedWorktreesForRepoCoalesced(repo.id, {
            executionHostId: hostId,
            reuseRecentCompatibilityFailure: true,
            directSshAuthority,
            connectionId: repo.connectionId,
            knownWorktreeIds: getKnownWorktreeIdsForPurge(requestStartedState, repo.id, hostId),
            isStaleCatalogPublication: (result) =>
              isStaleWorktreeCatalogPublication(get(), repo.id, hostId, result.catalogVersion)
          })
          if (refresh.status !== 'admitted') {
            return failed
          }
          const outcome = mergeFetchedWorktrees(set, get, {
            repoId: repo.id,
            hostId,
            ownerWasMissingAtStart: false,
            requestStartedWorktrees,
            setup,
            refresh,
            purgeRemovedWorktrees
          })
          return outcome === 'applied' ? { repoId: repo.id, hostId, refresh } : failed
        } catch (err) {
          if (!notifyRuntimeScopeForbiddenIfNeeded(err)) {
            console.error(`Failed to fetch worktrees for repo ${repo.id}:`, err)
          }
          return failed
        }
      }
    )
    if (!options?.visibilityOwnerHostId && options?.hydrationPurge !== 'defer') {
      purgeHydratedWorktrees(set, get, results)
    }
    return results
  }
}
