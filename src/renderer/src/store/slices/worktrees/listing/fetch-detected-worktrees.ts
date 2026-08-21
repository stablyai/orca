import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from './worktree-slice-types'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import { findRepoForHost } from '../../repo-host-identity'
import { getCurrentDirectSshAuthority } from './direct-ssh-authority'
import { listDetectedWorktreesForRepoCoalesced } from './detected-worktree-refresh'
import { isCurrentDetectedWorktreeRefresh } from './detected-worktree-refresh-admission'
import { mergeDetectedWorktreesForHost } from './detected-worktree-host-merge'
import { areDetectedWorktreeResultsEqual } from './worktree-catalog-visibility'
import {
  getKnownWorktreeIdsForPurge,
  getProjectHostSetupForRepoHost,
  repoHasExactlyOneExecutionHostOwner,
  repoHostId,
  worktreeHostMatchOptions
} from './worktree-host-ownership'
import { fetchKnownSshWorktreesForRepo } from './known-ssh-worktree-fetch'
import { notifyRuntimeScopeForbiddenIfNeeded } from './runtime-scope-forbidden-toast'
import { settingsForRepoOwner } from './worktree-owner-settings'

export function createFetchDetectedWorktrees(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['fetchDetectedWorktrees'] {
  return async (repoId) => {
    try {
      const ownerState = get()
      const hostId = repoHostId(ownerState, repoId)
      const ownerWasMissingAtStart = !ownerState.repos.some((repo) => repo.id === repoId)
      const setup = getProjectHostSetupForRepoHost(ownerState, repoId, hostId)
      const repoOwner = findRepoForHost(ownerState.repos, repoId, {
        hostId,
        settings: ownerState.settings
      })
      const parsedHost = parseExecutionHostId(hostId)
      const directSshAuthority =
        parsedHost?.kind === 'ssh'
          ? (getCurrentDirectSshAuthority(ownerState, hostId) ?? undefined)
          : undefined
      if (parsedHost?.kind === 'ssh' && !directSshAuthority) {
        // Why: this function's contract is detected-only. The fallback runs for its store side effect, but
        // callers keep seeing null as they did before the metadata path existed.
        await fetchKnownSshWorktreesForRepo(set, repoId, parsedHost.id)
        return null
      }
      const refresh = await listDetectedWorktreesForRepoCoalesced(
        settingsForRepoOwner(ownerState, repoId, hostId),
        repoId,
        {
          executionHostId: hostId,
          directSshAuthority,
          connectionId: repoOwner?.connectionId,
          knownWorktreeIds: getKnownWorktreeIdsForPurge(ownerState, repoId, hostId)
        }
      )
      if (refresh.status !== 'admitted') {
        return null
      }
      let admitted = false
      set((s) => {
        if (
          !isCurrentDetectedWorktreeRefresh(s, refresh) ||
          !repoHasExactlyOneExecutionHostOwner(
            s,
            repoId,
            hostId,
            ownerWasMissingAtStart && !refresh.directSshAuthority
          )
        ) {
          return s
        }
        admitted = true
        // Why: detected-only refreshes can overlap host-scoped visible refreshes; merge detected state so SSH/runtime rows aren't clobbered.
        const mergedDetected = mergeDetectedWorktreesForHost(
          s.detectedWorktreesByRepo[repoId],
          refresh.result,
          hostId,
          setup,
          worktreeHostMatchOptions(s, repoId, hostId)
        )
        return areDetectedWorktreeResultsEqual(s.detectedWorktreesByRepo[repoId], mergedDetected)
          ? s
          : {
              detectedWorktreesByRepo: {
                ...s.detectedWorktreesByRepo,
                [repoId]: mergedDetected
              }
            }
      })
      return admitted ? refresh.result : null
    } catch (err) {
      if (notifyRuntimeScopeForbiddenIfNeeded(err)) {
        return null
      }
      console.error(`Failed to fetch detected worktrees for repo ${repoId}:`, err)
      return null
    }
  }
}
