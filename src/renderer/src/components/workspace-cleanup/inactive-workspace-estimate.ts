import type { Repo } from '../../../../shared/repo-types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getPersistedWorkspaceCleanupActivityAt,
  isWorkspaceOldForCleanup
} from '../../../../shared/workspace-cleanup'

/**
 * Renderer-side estimate of how many workspaces the cleanup scan would list. It
 * sees only Orca's persisted activity record, so it disagrees with the scan by
 * design — the scan additionally reads each worktree's git history and cannot
 * inspect disconnected remotes.
 */
export function countEstimatedInactiveWorkspaces(
  worktrees: readonly Worktree[],
  repoById: ReadonlyMap<string, Repo>,
  now: number
): number {
  let count = 0
  for (const worktree of worktrees) {
    const repo = repoById.get(worktree.repoId)
    if (!repo || isFolderRepo(repo) || worktree.isMainWorktree) {
      continue
    }
    // Why: an unstamped workspace (externally created, or never opened here) reads as
    // epoch 0, which counted every one of them as idle and inflated the estimate far
    // past what the scan lists. Unknown is not old.
    const lastActivityAt = getPersistedWorkspaceCleanupActivityAt(worktree)
    if (
      lastActivityAt > 0 &&
      isWorkspaceOldForCleanup({ isArchived: worktree.isArchived, lastActivityAt }, now)
    ) {
      count += 1
    }
  }
  return count
}
