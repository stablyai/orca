import {
  getWorktreeLineageIdentity,
  sameWorktreeLineageIdentity,
  getRepresentedWorktreeLineageRow,
  getSidebarLineageParentsByIdentity
} from './worktree-lineage-projection'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import {
  filterWorkspaceRows,
  type WorkspaceRowFactReader,
  type WorkspaceRowFilters
} from '../workspace-view/workspace-row-filters'

export type VisibleSidebarWorktreeInputs = {
  /** Every catalog row, one per host-qualified identity. */
  rows: readonly Worktree[]
  /** Non-archived rows by host identity, the lineage ancestors a visible child may pull in. */
  ancestorByIdentity: ReadonlyMap<string, Worktree>
  /** A row's place in the frozen sort order; unranked rows go last. */
  rankOf: (worktree: Worktree) => number | undefined
  filters: WorkspaceRowFilters
  facts: WorkspaceRowFactReader<Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  filterRepoIds: readonly string[]
  injectLineageAncestors?: boolean
  preserveLineageParentOrder?: boolean
  forcedVisibleWorktreeIds?: readonly string[]
}

/** The sidebar's visible worktrees, in display order, before grouping. */
export function selectVisibleSidebarWorktrees({
  rows,
  ancestorByIdentity,
  rankOf,
  filters,
  facts,
  worktreeLineageById,
  filterRepoIds,
  injectLineageAncestors,
  preserveLineageParentOrder,
  forcedVisibleWorktreeIds
}: VisibleSidebarWorktreeInputs): Worktree[] {
  // Structural ancestors still respect explicit project and host display boundaries.
  const represented = new Map(rows.map((row) => [getWorktreeHostIdentity(row), row]))
  const selectedRepoIds = filterRepoIds.length > 0 ? new Set(filterRepoIds) : null

  const visibleHostIds = filters.visibleHostIds && new Set(filters.visibleHostIds)
  const admitsAncestor = (row: Worktree): boolean => {
    const hostId = facts.hostId(row)
    return (
      sameWorktreeLineageIdentity(
        represented.get(getWorktreeHostIdentity(row)) ??
          getRepresentedWorktreeLineageRow(ancestorByIdentity, row) ??
          row,
        row
      ) &&
      !row.isArchived &&
      (!selectedRepoIds || selectedRepoIds.has(row.repoId)) &&
      (!visibleHostIds || (hostId !== null && visibleHostIds.has(hostId)))
    )
  }
  let all = filterWorkspaceRows(rows, filters, facts)

  if (forcedVisibleWorktreeIds && forcedVisibleWorktreeIds.length > 0) {
    const includedIds = new Set(all.map((worktree) => worktree.id))
    for (const worktreeId of forcedVisibleWorktreeIds) {
      const worktree = includedIds.has(worktreeId)
        ? undefined
        : [...ancestorByIdentity.values()].find((candidate) => candidate.id === worktreeId)
      if (worktree && !worktree.isArchived) {
        includedIds.add(worktreeId)
        all.push(worktree)
      }
    }
  }

  // Append unranked/new rows until the next sortEpoch. Manual placement follows the parent, even if a hidden child ranks higher.
  if (injectLineageAncestors !== false && preserveLineageParentOrder) {
    all = addVisibleLineageAncestors(all, ancestorByIdentity, worktreeLineageById, admitsAncestor)
  }
  all = all
    .map((worktree) => ({ worktree, rank: rankOf(worktree) ?? Infinity }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ worktree }) => worktree)

  return injectLineageAncestors === false || preserveLineageParentOrder
    ? all
    : addVisibleLineageAncestors(all, ancestorByIdentity, worktreeLineageById, admitsAncestor)
}

function addVisibleLineageAncestors(
  worktrees: Worktree[],
  ancestorByIdentity: ReadonlyMap<string, Worktree>,
  lineageById: Record<string, WorktreeLineage>,
  admitsAncestor: (row: Worktree) => boolean
): Worktree[] {
  const result: Worktree[] = []
  const included = new Set<string>()
  // Use the same parent for ancestor injection and nesting.
  const parentByIdentity = getSidebarLineageParentsByIdentity(lineageById, ancestorByIdentity)

  const addWithAncestors = (worktree: Worktree): void => {
    const identity = getWorktreeLineageIdentity(worktree)
    if (included.has(identity)) {
      return
    }
    const parent = parentByIdentity.get(identity)
    if (parent && admitsAncestor(parent)) {
      addWithAncestors(parent)
    }
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
