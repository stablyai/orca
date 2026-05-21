import type { Worktree, WorktreeLineage } from '../../../../shared/types'

type WorkspaceDeleteLineage = {
  descendants: Worktree[]
  deleteAllTargets: Worktree[]
}

function isValidLineageLink(
  child: Worktree,
  parent: Worktree | undefined,
  lineage: WorktreeLineage | undefined
): parent is Worktree {
  return Boolean(
    lineage &&
    parent &&
    child.instanceId === lineage.worktreeInstanceId &&
    parent.instanceId === lineage.parentWorktreeInstanceId
  )
}

export function getWorkspaceDeleteLineage(
  parent: Worktree,
  worktrees: readonly Worktree[],
  lineageById: Record<string, WorktreeLineage>
): WorkspaceDeleteLineage {
  const worktreeById = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  const childrenByParentId = new Map<string, Worktree[]>()

  for (const worktree of worktrees) {
    const lineage = lineageById[worktree.id]
    const lineageParent = lineage ? worktreeById.get(lineage.parentWorktreeId) : undefined
    if (!isValidLineageLink(worktree, lineageParent, lineage)) {
      continue
    }
    const children = childrenByParentId.get(lineageParent.id) ?? []
    children.push(worktree)
    childrenByParentId.set(lineageParent.id, children)
  }

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
