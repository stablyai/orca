import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

type WorktreesByRepo = Record<string, Worktree[]>

/** Cache non-archived rows by host identity to preserve twins and avoid repeated lineage/cycle scans. */
const lineageAncestorIndexCache = new WeakMap<WorktreesByRepo, Map<string, Worktree>>()

export function getLineageAncestorIndex(worktreesByRepo: WorktreesByRepo): Map<string, Worktree> {
  const cached = lineageAncestorIndexCache.get(worktreesByRepo)
  if (cached) {
    return cached
  }
  const index = new Map<string, Worktree>()
  for (const worktree of getIndexedAllWorktrees(worktreesByRepo)) {
    if (!worktree.isArchived) {
      index.set(getWorktreeHostIdentity(worktree), worktree)
    }
  }
  lineageAncestorIndexCache.set(worktreesByRepo, index)
  return index
}

/** Reuse ranks while the frozen sidebar sort array retains its identity. */
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
