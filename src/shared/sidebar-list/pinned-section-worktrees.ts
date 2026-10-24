import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import {
  getWorktreeLineageIdentity,
  getSidebarLineageParentsByIdentity,
  sameWorktreeLineageIdentity
} from './worktree-lineage-projection'
import { getLineagePlacementRows } from '../worktree-occurrence-plan'

export function getSidebarLineageChildren(
  worktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>,
  filterRepoIds: readonly string[] = []
): Map<string, Worktree[]> {
  const rowsByIdentity = worktreeMap
  const visible = new Map(worktrees.map((row) => [getWorktreeLineageIdentity(row), row]))
  const allowedRepoIds = filterRepoIds.length > 0 ? new Set(filterRepoIds) : null
  const parentByIdentity = getSidebarLineageParentsByIdentity(lineageById, rowsByIdentity)
  const childrenByParentIdentity = new Map<string, Worktree[]>()
  for (const child of rowsByIdentity.values()) {
    const childIdentity = getWorktreeLineageIdentity(child)
    const parent = parentByIdentity.get(childIdentity)
    if (
      !parent ||
      !sameWorktreeLineageIdentity(visible.get(childIdentity) ?? child, child) ||
      !visible.has(childIdentity) ||
      !visible.has(getWorktreeLineageIdentity(parent)) ||
      !sameWorktreeLineageIdentity(
        visible.get(getWorktreeLineageIdentity(parent)) ?? parent,
        parent
      ) ||
      (allowedRepoIds && (!allowedRepoIds.has(child.repoId) || !allowedRepoIds.has(parent.repoId)))
    ) {
      continue
    }
    const identity = getWorktreeLineageIdentity(parent)
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
    identityOf: getWorktreeLineageIdentity,
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
  const identity = getWorktreeLineageIdentity(worktree)
  return getPinnedSectionWorktrees(visibleWorktrees, lineageById, worktreeMap, filterRepoIds).some(
    (candidate) => getWorktreeLineageIdentity(candidate) === identity
  )
}
