import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  replacedWorktreeRows,
  type ReplacedWorktreeRow
} from '@/store/slices/worktrees/listing/worktree-catalog-membership'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

type WorktreesByRepo = Record<string, Worktree[]>

/** Cache non-archived rows by host identity to preserve twins and avoid repeated lineage/cycle scans. */
const lineageAncestorIndexCache = new WeakMap<WorktreesByRepo, Map<string, Worktree>>()
let lastLineage: { worktreesByRepo: WorktreesByRepo; index: Map<string, Worktree> } | null = null

export function getLineageAncestorIndex(worktreesByRepo: WorktreesByRepo): Map<string, Worktree> {
  const cached = lineageAncestorIndexCache.get(worktreesByRepo)
  if (cached) {
    return cached
  }
  const replaced = lastLineage && replacedWorktreeRows(worktreesByRepo, lastLineage.worktreesByRepo)
  const index =
    lastLineage && replaced
      ? patchLineageAncestorIndex(lastLineage.index, replaced)
      : buildLineageAncestorIndex(worktreesByRepo)
  lineageAncestorIndexCache.set(worktreesByRepo, index)
  lastLineage = { worktreesByRepo, index }
  return index
}

// Archive state is unchanged for replaced rows, so a row is indexed exactly when its predecessor was.
function patchLineageAncestorIndex(
  previous: Map<string, Worktree>,
  replaced: readonly ReplacedWorktreeRow[]
): Map<string, Worktree> {
  if (replaced.length === 0) {
    return previous
  }
  const index = new Map(previous)
  for (const { before, after } of replaced) {
    const identity = getWorktreeHostIdentity(before)
    if (index.get(identity) === before) {
      index.set(identity, after)
    }
  }
  return index
}

function buildLineageAncestorIndex(worktreesByRepo: WorktreesByRepo): Map<string, Worktree> {
  const index = new Map<string, Worktree>()
  for (const worktree of getIndexedAllWorktrees(worktreesByRepo)) {
    if (!worktree.isArchived) {
      index.set(getWorktreeHostIdentity(worktree), worktree)
    }
  }
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
