import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { getLineagePlacementRows } from '../worktree-occurrence-plan'
import { getSidebarLineageParentsByIdentity } from './worktree-lineage-projection'

export function getSidebarLineageRowsByIdentity(
  worktrees: readonly Worktree[],
  worktreeMap: ReadonlyMap<string, Worktree>
): Map<string, Worktree> {
  return new Map(
    [...worktreeMap.values(), ...worktrees].map((worktree) => [
      getWorktreeHostIdentity(worktree),
      worktree
    ])
  )
}

export function getSidebarLineageChildren(
  worktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>,
  filterRepoIds: readonly string[] = []
): Map<string, Worktree[]> {
  const rowsByIdentity = getSidebarLineageRowsByIdentity(worktrees, worktreeMap)
  const allowedRepoIds = filterRepoIds.length > 0 ? new Set(filterRepoIds) : null
  const parentByIdentity = getSidebarLineageParentsByIdentity(lineageById, rowsByIdentity)
  const childrenByParentIdentity = new Map<string, Worktree[]>()
  for (const [childIdentity, child] of rowsByIdentity) {
    const parent = parentByIdentity.get(childIdentity)
    if (
      !parent ||
      (allowedRepoIds && (!allowedRepoIds.has(child.repoId) || !allowedRepoIds.has(parent.repoId)))
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
