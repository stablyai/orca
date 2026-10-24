import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getWorktreeLineageProjection,
  findWorktreeLineageRow,
  getWorktreeLineageIdentity
} from '../../../../shared/sidebar-list/worktree-lineage-projection'
import { getSavedWorktreeLineage } from '../../../../shared/resolved-worktree-lineage'

type ParentEligibilityArgs = {
  child: Worktree
  candidateParent: Worktree
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
}

export function canAssignWorktreeParent({
  child,
  candidateParent,
  lineageById,
  worktreeMap
}: ParentEligibilityArgs): boolean {
  const identity = getWorktreeLineageIdentity(child)
  const graph = getWorktreeLineageProjection(lineageById, worktreeMap)
  const parent = findWorktreeLineageRow(worktreeMap, candidateParent)
  const currentChild = findWorktreeLineageRow(worktreeMap, child)
  if (!parent || !currentChild) {
    return false
  }
  if (
    identity === getWorktreeLineageIdentity(parent) ||
    graph.parents.get(currentChild) === parent
  ) {
    return false
  }
  let current: Worktree | undefined = parent
  while (current) {
    const key = getWorktreeLineageIdentity(current)
    if (
      key === identity ||
      graph.cyclicIdentities.has(key) ||
      getSavedWorktreeLineage(current, lineageById)?.parentStore === 'external'
    ) {
      return false
    }
    current = graph.parents.get(current)
  }
  return true
}
