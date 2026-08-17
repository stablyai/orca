import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getProjectedWorktreeLineageChildrenByParentId } from './worktree-lineage-projection'

// Why: pin is placement of the clicked row. Descendants keep their own isPinned
// and still follow a visible pinned ancestor into the Pinned section.
export function getPinnedSectionWorktrees(
  worktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): Worktree[] {
  const visibleIds = new Set(worktrees.map((worktree) => worktree.id))
  const childrenByParentId = getProjectedWorktreeLineageChildrenByParentId(lineageById, worktreeMap)
  const included = new Set<string>()
  const seen = new Set<string>()
  const pendingIds = worktrees
    .filter((worktree) => worktree.isPinned)
    .map((worktree) => worktree.id)

  while (pendingIds.length > 0) {
    const id = pendingIds.pop()
    if (!id) {
      continue
    }
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    if (visibleIds.has(id)) {
      included.add(id)
    }
    for (const child of childrenByParentId.get(id) ?? []) {
      pendingIds.push(child.id)
    }
  }

  return worktrees.filter((worktree) => included.has(worktree.id))
}

export function isPinnedSectionWorktree(
  worktree: Worktree,
  visibleWorktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): boolean {
  if (worktree.isPinned) {
    return true
  }
  return getPinnedSectionWorktrees(visibleWorktrees, lineageById, worktreeMap).some(
    (candidate) => candidate.id === worktree.id
  )
}
