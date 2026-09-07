import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import type { Worktree } from '../../../../shared/worktree/types'

type WorktreesByRepo = Record<string, Worktree[]>

/**
 * Non-archived rows by id — the map `computeVisibleWorktrees` hands to the
 * lineage projection.
 *
 * Why cached: `getCyclicProjectedWorktreeLineageIds` keys its memo on this map's
 * identity, so a per-call Map is a guaranteed miss that re-walks every workspace
 * and re-runs cycle detection on each PTY, tab and agent-status write.
 *
 * Why not the store's `getIndexedWorktreeMap`: this index excludes archived rows
 * (an archived parent resolving as a valid ancestor would inject a phantom row),
 * and it keeps the last row for a two-host id collision rather than the first.
 */
const lineageAncestorIndexCache = new WeakMap<WorktreesByRepo, Map<string, Worktree>>()

export function getLineageAncestorIndex(worktreesByRepo: WorktreesByRepo): Map<string, Worktree> {
  const cached = lineageAncestorIndexCache.get(worktreesByRepo)
  if (cached) {
    return cached
  }
  const index = new Map<string, Worktree>()
  for (const worktree of getIndexedAllWorktrees(worktreesByRepo)) {
    if (!worktree.isArchived) {
      index.set(worktree.id, worktree)
    }
  }
  lineageAncestorIndexCache.set(worktreesByRepo, index)
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
