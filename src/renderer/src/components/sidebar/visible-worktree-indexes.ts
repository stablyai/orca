import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import type { Worktree } from '../../../../shared/worktree/types'
import { isWorkspaceSnoozed } from '../../../../shared/workspace-snooze'

type WorktreesByRepo = Record<string, Worktree[]>

/**
 * Non-archived rows by id, the map `computeVisibleWorktrees` hands to the lineage
 * projection. Snoozed rows are included only while the snooze peek is on.
 *
 * Why cached: `getCyclicProjectedWorktreeLineageIds` keys its memo on this map's
 * identity, so a per-call Map is a guaranteed miss that re-walks every workspace
 * and re-runs cycle detection on each PTY, tab and agent-status write.
 *
 * Why not the store's `getIndexedWorktreeMap`: this index excludes archived rows
 * and, with the peek off, snoozed rows (a hidden parent resolving as a valid ancestor
 * would inject a row the user hid), and it keeps the last row for a two-host id
 * collision rather than the first.
 *
 * Why peek-aware: with the peek on, a snoozed parent is visible, and its children
 * must still resolve it as their parent.
 */
const lineageAncestorIndexCaches = {
  withSnoozed: new WeakMap<WorktreesByRepo, Map<string, Worktree>>(),
  withoutSnoozed: new WeakMap<WorktreesByRepo, Map<string, Worktree>>()
}

export function getLineageAncestorIndex(
  worktreesByRepo: WorktreesByRepo,
  showSnoozedWorkspaces: boolean
): Map<string, Worktree> {
  const cache = showSnoozedWorkspaces
    ? lineageAncestorIndexCaches.withSnoozed
    : lineageAncestorIndexCaches.withoutSnoozed
  const cached = cache.get(worktreesByRepo)
  if (cached) {
    return cached
  }
  const index = new Map<string, Worktree>()
  for (const worktree of getIndexedAllWorktrees(worktreesByRepo)) {
    if (!worktree.isArchived && (showSnoozedWorkspaces || !isWorkspaceSnoozed(worktree))) {
      index.set(worktree.id, worktree)
    }
  }
  cache.set(worktreesByRepo, index)
  return index
}

/**
 * Rank of each id in the frozen sidebar sort order. Keyed on the array the sort
 * hook already holds identity-stable across unrelated store writes.
 */
const sortedWorktreeRankIndexCache = new WeakMap<readonly string[], Map<string, number>>()

export function getSortedWorktreeRankIndex(sortedIds: readonly string[]): Map<string, number> {
  const cached = sortedWorktreeRankIndexCache.get(sortedIds)
  if (cached) {
    return cached
  }
  const index = new Map(sortedIds.map((id, rank) => [id, rank]))
  sortedWorktreeRankIndexCache.set(sortedIds, index)
  return index
}
