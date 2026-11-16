import type {
  DetectedWorktree,
  WorktreeHeadIdentity
} from '../../../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { AppState } from '../../../types'
import { findWorktreeByPath } from '../../../../hooks/worktree-head-identity-apply'
import { deriveGitIdentityDisplayName } from '../metadata/detached-head-display-name'
import { worktreeHostMatchOptions, worktreeMatchesHost } from './worktree-host-ownership'
import { selectDetectedWorktreesByRepo } from '../../../workspaces/catalog/workspace-record-fields'

/** Head-only watcher bursts no longer re-list, so local detected rows take the same head patch as visible rows. */
export function patchDetectedWorktreeHeadIdentities(
  state: Pick<AppState, 'repos' | 'detectedWorktreesByRepo'>,
  repoId: string,
  identities: readonly WorktreeHeadIdentity[]
): Pick<AppState, 'detectedWorktreesByRepo'> | null {
  const detectedByRepo = selectDetectedWorktreesByRepo(state)
  const detected = detectedByRepo[repoId]
  if (!detected) {
    return null
  }
  const options = worktreeHostMatchOptions(state, repoId, LOCAL_EXECUTION_HOST_ID)
  // Why local only: the watcher reads this machine's checkouts, never a same-path twin on another host.
  const localRows = detected.worktrees.filter((row) =>
    worktreeMatchesHost(row, LOCAL_EXECUTION_HOST_ID, options)
  )
  let worktrees = detected.worktrees
  for (const identity of identities) {
    const row = findWorktreeByPath(localRows, identity.worktreePath)
    const branch = identity.branch ?? ''
    if (!row || (row.head === identity.head && row.branch === branch)) {
      continue
    }
    const patched: DetectedWorktree = {
      ...row,
      head: identity.head,
      branch,
      displayName: deriveGitIdentityDisplayName(row, row.id, branch, identity.branch)
    }
    worktrees = worktrees.map((candidate) => (candidate === row ? patched : candidate))
  }
  return worktrees === detected.worktrees
    ? null
    : {
        detectedWorktreesByRepo: {
          ...detectedByRepo,
          [repoId]: { ...detected, worktrees }
        }
      }
}

/** A listing that started before a head patch must not roll that row's head, branch or derived name back. */
export function preserveConcurrentDetectedHeads(
  merged: DetectedWorktree[],
  requestStarted: readonly DetectedWorktree[] | undefined,
  current: readonly DetectedWorktree[] | undefined,
  matchesRefreshHost: (worktree: DetectedWorktree) => boolean
): DetectedWorktree[] {
  if (!requestStarted || !current || requestStarted === current) {
    return merged
  }
  const startedById = new Map(
    requestStarted.filter(matchesRefreshHost).map((worktree) => [worktree.id, worktree])
  )
  const currentById = new Map(
    current.filter(matchesRefreshHost).map((worktree) => [worktree.id, worktree])
  )
  let changed = false
  const worktrees = merged.map((worktree) => {
    const started = startedById.get(worktree.id)
    const latest = currentById.get(worktree.id)
    if (
      !matchesRefreshHost(worktree) ||
      !started ||
      !latest ||
      (latest.head === started.head && latest.branch === started.branch) ||
      (worktree.head === latest.head && worktree.branch === latest.branch)
    ) {
      return worktree
    }
    changed = true
    return {
      ...worktree,
      head: latest.head,
      branch: latest.branch,
      displayName: latest.displayName
    }
  })
  return changed ? worktrees : merged
}
