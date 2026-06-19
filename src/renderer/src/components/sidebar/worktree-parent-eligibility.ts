import type { Worktree, WorktreeLineage } from '../../../../shared/types'
import { getLineageRenderInfo } from './worktree-list-groups'

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
  if (child.id === candidateParent.id) {
    return false
  }

  const childLineage = getLineageRenderInfo(child, lineageById, worktreeMap)
  if (childLineage.state === 'valid' && childLineage.parent.id === candidateParent.id) {
    return false
  }

  let current: Worktree | undefined = candidateParent
  const visited = new Set<string>()
  while (current) {
    if (visited.has(current.id)) {
      return false
    }
    visited.add(current.id)
    if (current.id === child.id) {
      return false
    }
    const lineageInfo = getLineageRenderInfo(current, lineageById, worktreeMap)
    // Why: stale instance links are broken edges for renderer filtering; the
    // backend remains the authoritative final cycle guard.
    current = lineageInfo.state === 'valid' ? lineageInfo.parent : undefined
  }

  return true
}
