import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { isWorktreeRetiredByRemoval } from '../worktree/removal-visibility'
import {
  filterWorkspaceRows,
  type WorkspaceRowFactReader,
  type WorkspaceRowFilters
} from '../workspace-view/workspace-row-filters'
import {
  getSidebarLineageParentsByIdentity,
  type SidebarLineageParentIdentities
} from './worktree-lineage-projection'

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
  /** Parents resolved once over every visible store's complete rows; ancestor injection reuses them. */
  lineageParentIdentities?: SidebarLineageParentIdentities
  filterRepoIds: readonly string[]
  injectLineageAncestors?: boolean
  preserveLineageParentOrder?: boolean
  forcedVisibleWorktreeIds?: readonly string[]
}

/** The sidebar's visible worktrees, in display order, before grouping. */
export function selectVisibleSidebarWorktrees({
  rows,
  ancestorByIdentity: everyAncestorByIdentity,
  rankOf,
  filters,
  facts,
  worktreeLineageById,
  lineageParentIdentities,
  filterRepoIds,
  injectLineageAncestors,
  preserveLineageParentOrder,
  forcedVisibleWorktreeIds
}: VisibleSidebarWorktreeInputs): Worktree[] {
  // Keep valid nonarchived ancestors despite ordinary filters so children retain their hierarchy.
  const listedFilterIds = filterRepoIds.filter((id) => !facts.isProjectHidden(id))
  const selectedRepoIds = listedFilterIds.length > 0 ? new Set(listedFilterIds) : null
  // Hidden projects are no filter: neither a reveal nor a child's lineage brings their rows back.
  const ancestorByIdentity = withoutHiddenProjectRows(everyAncestorByIdentity, facts)

  let all = filterWorkspaceRows(rows, filters, {
    ...facts,
    isArchived: (row) => facts.isArchived(row) || isWorktreeRetiredByRemoval(row)
  })

  if (forcedVisibleWorktreeIds && forcedVisibleWorktreeIds.length > 0) {
    const includedIds = new Set(all.map((worktree) => worktree.id))
    for (const worktreeId of forcedVisibleWorktreeIds) {
      const worktree = includedIds.has(worktreeId)
        ? undefined
        : [...ancestorByIdentity.values()].find((candidate) => candidate.id === worktreeId)
      if (worktree && !isWorktreeRetiredByRemoval(worktree)) {
        includedIds.add(worktreeId)
        all.push(worktree)
      }
    }
  }

  // Append unranked/new rows until the next sortEpoch. Manual placement follows the parent, even if a hidden child ranks higher.
  if (injectLineageAncestors !== false && preserveLineageParentOrder) {
    all = addVisibleLineageAncestors(
      all,
      ancestorByIdentity,
      worktreeLineageById,
      selectedRepoIds,
      lineageParentIdentities
    )
  }
  all = all
    .map((worktree) => ({ worktree, rank: rankOf(worktree) ?? Infinity }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ worktree }) => worktree)

  return injectLineageAncestors === false || preserveLineageParentOrder
    ? all
    : addVisibleLineageAncestors(
        all,
        ancestorByIdentity,
        worktreeLineageById,
        selectedRepoIds,
        lineageParentIdentities
      )
}

function withoutHiddenProjectRows(
  rows: ReadonlyMap<string, Worktree>,
  facts: WorkspaceRowFactReader<Worktree>
): ReadonlyMap<string, Worktree> {
  let kept: Map<string, Worktree> | null = null
  for (const [identity, worktree] of rows) {
    if (facts.isInHiddenProject(worktree)) {
      kept ??= new Map(rows)
      kept.delete(identity)
    }
  }
  return kept ?? rows
}

function addVisibleLineageAncestors(
  worktrees: Worktree[],
  ancestorByIdentity: ReadonlyMap<string, Worktree>,
  lineageById: Record<string, WorktreeLineage>,
  selectedRepoIds: ReadonlySet<string> | null,
  lineageParentIdentities: SidebarLineageParentIdentities | undefined
): Worktree[] {
  const result: Worktree[] = []
  const included = new Set<string>()
  // Use the same parent for ancestor injection and nesting.
  const parentByIdentity = getSidebarLineageParentsByIdentity(
    lineageById,
    ancestorByIdentity,
    lineageParentIdentities
  )

  // An older peer's loop reaches a row again before it is included.
  const visiting = new Set<string>()
  const addWithAncestors = (worktree: Worktree): void => {
    if (isWorktreeRetiredByRemoval(worktree)) {
      return
    }
    const identity = getWorktreeHostIdentity(worktree)
    if (included.has(identity) || visiting.has(identity)) {
      return
    }
    visiting.add(identity)
    const parent = parentByIdentity.get(identity)
    // Repository filters are hard boundaries; ordinary filters may retain ancestors.
    if (parent && (!selectedRepoIds || selectedRepoIds.has(parent.repoId))) {
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
