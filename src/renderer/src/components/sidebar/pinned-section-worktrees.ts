import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getProjectedWorktreeLineageChildrenByParentId } from './worktree-lineage-projection'

// Why: pin is placement of the clicked row. Descendants keep their own isPinned
// and still follow a visible pinned ancestor into the Pinned section.
export function getPinnedSectionWorktrees(
  worktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): Worktree[] {
  const visibleIdentities = new Set(worktrees.map(getWorktreeHostIdentity))
  const childrenByParentId = getProjectedWorktreeLineageChildrenByParentId(lineageById, worktreeMap)
  const included = new Set<string>()
  const seen = new Set<string>()
  const pendingWorktrees = worktrees
    .filter((worktree) => worktree.isPinned)
    .map(({ id, hostId }) => ({ id, hostId }))

  while (pendingWorktrees.length > 0) {
    const current = pendingWorktrees.pop()
    if (!current) {
      continue
    }
    const identity = getWorktreeHostIdentity(current)
    if (seen.has(identity)) {
      continue
    }
    seen.add(identity)
    if (visibleIdentities.has(identity)) {
      included.add(identity)
    }
    for (const child of childrenByParentId.get(current.id) ?? []) {
      // Lineage ids are hostless, but a lineage edge cannot cross execution hosts.
      pendingWorktrees.push({ id: child.id, hostId: current.hostId })
    }
  }

  return worktrees.filter((worktree) => included.has(getWorktreeHostIdentity(worktree)))
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
  const identity = getWorktreeHostIdentity(worktree)
  return getPinnedSectionWorktrees(visibleWorktrees, lineageById, worktreeMap).some(
    (candidate) => getWorktreeHostIdentity(candidate) === identity
  )
}
