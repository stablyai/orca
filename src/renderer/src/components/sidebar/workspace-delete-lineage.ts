import type { Worktree, WorktreeLineage } from '../../../../shared/types'
import { getProjectedWorktreeLineageChildrenByParentId } from './worktree-lineage-projection'

type WorkspaceDeleteLineage = {
  descendants: Worktree[]
  deleteAllTargets: Worktree[]
}

export function getWorkspaceDeleteLineage(
  parent: Worktree,
  worktrees: readonly Worktree[],
  lineageById: Record<string, WorktreeLineage>
): WorkspaceDeleteLineage {
  const worktreeById = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  const childrenByParentId = getProjectedWorktreeLineageChildrenByParentId(
    lineageById,
    worktreeById
  )

  const descendants: Worktree[] = []
  const childFirstTargets: Worktree[] = []
  const visiting = new Set<string>()
  const emitted = new Set<string>([parent.id])

  const visit = (worktreeId: string): void => {
    if (visiting.has(worktreeId)) {
      return
    }
    visiting.add(worktreeId)
    const children = childrenByParentId.get(worktreeId) ?? []
    for (const child of children) {
      if (emitted.has(child.id)) {
        continue
      }
      emitted.add(child.id)
      descendants.push(child)
      visit(child.id)
      if (!child.isMainWorktree) {
        childFirstTargets.push(child)
      }
    }
    visiting.delete(worktreeId)
  }

  visit(parent.id)

  return {
    descendants,
    // Why: if a child workspace physically lives inside the parent directory,
    // deleting descendants first prevents Git's force-delete path from removing
    // the child as untracked content under the parent.
    deleteAllTargets: [...childFirstTargets, parent]
  }
}
