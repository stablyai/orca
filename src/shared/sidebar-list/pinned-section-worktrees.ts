import { projectRepoFilterMatcher } from '../project-grouping'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { getLineagePlacementRows } from '../worktree-occurrence-plan'
import {
  getSidebarLineageParentsByIdentity,
  type SidebarLineageParentIdentities
} from './worktree-lineage-projection'

export function getSidebarLineageRowsByIdentity(
  worktrees: readonly Worktree[],
  worktreeMap: ReadonlyMap<string, Worktree>,
  folderRows: readonly Worktree[] = []
): Map<string, Worktree> {
  return new Map(
    [...worktreeMap.values(), ...worktrees, ...folderRows].map((worktree) => [
      getWorktreeHostIdentity(worktree),
      worktree
    ])
  )
}

/** Children by parent identity. Folder workspace rows parent only through resolved identities, and a
 * shown folder is never hidden by the project filter, which names repos. */
export function getSidebarLineageChildren(
  worktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>,
  filterRepoIds: readonly string[] = [],
  lineageParentIdentities?: SidebarLineageParentIdentities,
  folderRows: readonly Worktree[] = []
): Map<string, Worktree[]> {
  const rowsByIdentity = getSidebarLineageRowsByIdentity(
    worktrees,
    worktreeMap,
    lineageParentIdentities ? folderRows : []
  )
  const folderIdentities = new Set(folderRows.map(getWorktreeHostIdentity))
  const matchesRepo = projectRepoFilterMatcher(filterRepoIds)
  const parentByIdentity = getSidebarLineageParentsByIdentity(
    lineageById,
    rowsByIdentity,
    lineageParentIdentities
  )
  const childrenByParentIdentity = new Map<string, Worktree[]>()
  for (const [childIdentity, child] of rowsByIdentity) {
    const parent = parentByIdentity.get(childIdentity)
    if (
      !parent ||
      !matchesRepo(child.repoId, child.hostId ?? 'local') ||
      (!matchesRepo(parent.repoId, parent.hostId ?? 'local') &&
        !folderIdentities.has(getWorktreeHostIdentity(parent)))
    ) {
      continue
    }
    const identity = getWorktreeHostIdentity(parent)
    const children = childrenByParentIdentity.get(identity) ?? []
    children.push(child)
    childrenByParentIdentity.set(identity, children)
  }
  return childrenByParentIdentity
}

// Why: pin is placement of the clicked row. Descendants keep their own isPinned
// and still follow a visible pinned ancestor into the Pinned section.
export function getPinnedSectionWorktrees(
  worktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>,
  filterRepoIds: readonly string[] = []
): Worktree[] {
  return getLineagePlacementRows({
    rows: worktrees,
    isPinned: (worktree) => worktree.isPinned === true,
    childrenByParentIdentity: getSidebarLineageChildren(
      worktrees,
      lineageById,
      worktreeMap,
      filterRepoIds
    ),
    identityOf: getWorktreeHostIdentity,
    duplicatePinned: false
  }).pinned
}

export function isPinnedSectionWorktree(
  worktree: Worktree,
  visibleWorktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>,
  filterRepoIds: readonly string[] = []
): boolean {
  if (worktree.isPinned) {
    return true
  }
  const identity = getWorktreeHostIdentity(worktree)
  return getPinnedSectionWorktrees(visibleWorktrees, lineageById, worktreeMap, filterRepoIds).some(
    (candidate) => getWorktreeHostIdentity(candidate) === identity
  )
}
