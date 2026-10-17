import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { EMPTY_CONCEALED_REPO_IDS } from '../incognito-projects'
import {
  filterWorkspaceRows,
  type WorkspaceRowFactReader,
  type WorkspaceRowFilters
} from '../workspace-view/workspace-row-filters'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo
} from './worktree-lineage-projection'

export type VisibleSidebarWorktreeInputs = {
  /** Every catalog row, one per host-qualified identity. */
  rows: readonly Worktree[]
  /** Non-archived rows by id, the lineage ancestors a visible child may pull in. */
  ancestorById: ReadonlyMap<string, Worktree>
  /** Rank of each id in the frozen sort order; unranked rows go last. */
  rankById: ReadonlyMap<string, number>
  filters: WorkspaceRowFilters
  facts: WorkspaceRowFactReader<Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  filterRepoIds: readonly string[]
  injectLineageAncestors?: boolean
  preserveLineageParentOrder?: boolean
  forcedVisibleWorktreeIds?: readonly string[]
  /** Locked incognito repos; nothing (forced rows, lineage ancestors) may bring them back. */
  concealedRepoIds?: ReadonlySet<string>
}

/** The sidebar's visible worktrees, in display order, before grouping. */
export function selectVisibleSidebarWorktrees({
  rows,
  ancestorById,
  rankById,
  filters,
  facts,
  worktreeLineageById,
  filterRepoIds,
  injectLineageAncestors,
  preserveLineageParentOrder,
  forcedVisibleWorktreeIds,
  concealedRepoIds = EMPTY_CONCEALED_REPO_IDS
}: VisibleSidebarWorktreeInputs): Worktree[] {
  const isShown = (w: Worktree): boolean => !concealedRepoIds.has(w.repoId)

  // Why: sidebar lineage is structural. Archived workspaces stay hidden, but
  // every other valid ancestor can bypass filters so children never orphan.
  const selectedRepoIds = filterRepoIds.length > 0 ? new Set(filterRepoIds) : null

  let all = filterWorkspaceRows(
    concealedRepoIds.size > 0 ? rows.filter(isShown) : rows,
    filters,
    facts
  )

  if (forcedVisibleWorktreeIds && forcedVisibleWorktreeIds.length > 0) {
    const includedIds = new Set(all.map((worktree) => worktree.id))
    for (const worktreeId of forcedVisibleWorktreeIds) {
      const worktree = ancestorById.get(worktreeId)
      if (worktree && !includedIds.has(worktreeId) && isShown(worktree)) {
        includedIds.add(worktreeId)
        all.push(worktree)
      }
    }
  }

  // Apply cached sort order. Items not yet in the cache (e.g. brand-new
  // worktrees before the next sortEpoch bump) are appended at the end.
  // Manual placement belongs to the parent, even when a hidden child has a higher rank.
  if (injectLineageAncestors !== false && preserveLineageParentOrder) {
    all = addVisibleLineageAncestors(all, ancestorById, worktreeLineageById, selectedRepoIds)
  }
  all.sort((a, b) => {
    const ai = rankById.get(a.id) ?? Infinity
    const bi = rankById.get(b.id) ?? Infinity
    return ai - bi
  })

  const result =
    injectLineageAncestors === false || preserveLineageParentOrder
      ? all
      : addVisibleLineageAncestors(all, ancestorById, worktreeLineageById, selectedRepoIds)
  return concealedRepoIds.size === 0 ? result : result.filter(isShown)
}

function addVisibleLineageAncestors(
  worktrees: Worktree[],
  worktreeById: ReadonlyMap<string, Worktree>,
  lineageById: Record<string, WorktreeLineage>,
  selectedRepoIds: ReadonlySet<string> | null
): Worktree[] {
  const result: Worktree[] = []
  const included = new Set<string>()
  const visiting = new Set<string>()
  const cyclicLineageIds = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeById)

  const addWithAncestors = (worktree: Worktree): void => {
    const identity = getWorktreeHostIdentity(worktree)
    if (included.has(identity) || visiting.has(identity)) {
      return
    }
    visiting.add(identity)
    const lineage = getLineageRenderInfo(worktree, lineageById, worktreeById, cyclicLineageIds)
    if (
      lineage.state === 'valid' &&
      (!selectedRepoIds || selectedRepoIds.has(lineage.parent.repoId))
    ) {
      // Why: a repository filter is an explicit boundary; other filters keep
      // valid ancestors so visible children retain their hierarchy.
      addWithAncestors(lineage.parent)
    }
    visiting.delete(identity)
    if (!included.has(identity)) {
      included.add(identity)
      result.push(worktree)
    }
  }

  for (const worktree of worktrees) {
    addWithAncestors(worktree)
  }
  return result
}
