import type { WorkspaceSortBy } from '../../workspace-view/workspace-row-sort'

export function orderMainWorktreeFirst<T extends { isMainWorktree?: boolean }>(
  worktrees: T[],
  sortBy: WorkspaceSortBy
): T[] {
  if (sortBy === 'manual') {
    return worktrees
  }
  const mainWorktrees = worktrees.filter((worktree) => worktree.isMainWorktree)
  if (mainWorktrees.length === 0) {
    return worktrees
  }
  // Keep canonical workspaces first for repo-scanned project groups despite dynamic child ranking.
  return [...mainWorktrees, ...worktrees.filter((worktree) => !worktree.isMainWorktree)]
}
