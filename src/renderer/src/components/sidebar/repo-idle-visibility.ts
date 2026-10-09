import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { isInactiveWorkspace } from '@/lib/worktree-activity-state'
import type { VisibleWorktreeOptions } from './visible-worktrees'

/**
 * Per-repo "Hide when idle": the repo-scoped counterpart of the global "Hide sleeping" filter.
 *
 * Why it overrides the main-checkout exemption: the repos that opt in are interchangeable clones
 * whose main checkout is the workspace, so exempting it would keep every idle clone listed.
 */
export function isHiddenWhileIdle(worktree: Worktree, opts: VisibleWorktreeOptions): boolean {
  if (!opts.repoMap.get(worktree.repoId)?.hideWhenIdle) {
    return false
  }
  // Why: opening a workspace from Jump to workspace must not leave it invisible before its first terminal starts.
  if (worktree.id === opts.activeWorktreeId) {
    return false
  }
  // Why: a null map means the caller skipped activity tracking; showing beats hiding every row.
  if (!opts.tabsByWorktree) {
    return false
  }
  return isInactiveWorkspace(
    worktree.id,
    opts.tabsByWorktree,
    opts.ptyIdsByTabId,
    opts.browserTabsByWorktree,
    opts.worktreeIdsWithLiveAgent,
    opts.worktreeIdsWithStructuredChat
  )
}

export function someRepoHidesWhenIdle(repoMap: ReadonlyMap<string, Repo>): boolean {
  for (const repo of repoMap.values()) {
    if (repo.hideWhenIdle) {
      return true
    }
  }
  return false
}
