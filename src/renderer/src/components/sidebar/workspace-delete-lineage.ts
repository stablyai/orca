import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getWorktreeLineageProjection,
  findWorktreeLineageRow,
  getWorktreeLineageRows
} from '../../../../shared/sidebar-list/worktree-lineage-projection'

type WorkspaceDeleteLineage = {
  descendants: Worktree[]
  deleteAllTargets: Worktree[]
}

export function getWorkspaceDeleteLineage(
  parent: Worktree,
  worktrees: readonly Worktree[] | ReadonlyMap<string, Worktree>,
  lineageById: Record<string, WorktreeLineage>
): WorkspaceDeleteLineage {
  const rows = 'get' in worktrees ? worktrees : getWorktreeLineageRows(worktrees)
  const canonical = findWorktreeLineageRow(rows, parent)
  if (!canonical) {
    return { descendants: [], deleteAllTargets: [] }
  }
  parent = canonical
  const { children: childrenByParent } = getWorktreeLineageProjection(lineageById, rows)

  const descendants: Worktree[] = []
  const childFirstTargets: Worktree[] = []
  const visiting = new Set<Worktree>()
  const emitted = new Set<Worktree>([parent])

  const visit = (row: Worktree): void => {
    if (visiting.has(row)) {
      return
    }
    visiting.add(row)
    const children = childrenByParent.get(row) ?? []
    for (const child of children) {
      if (emitted.has(child)) {
        continue
      }
      emitted.add(child)
      descendants.push(child)
      visit(child)
      if (!child.isMainWorktree) {
        childFirstTargets.push(child)
      }
    }
    visiting.delete(row)
  }

  visit(parent)

  return {
    descendants,
    // Why: if a child workspace physically lives inside the parent directory,
    // deleting descendants first prevents Git's force-delete path from removing
    // the child as untracked content under the parent.
    deleteAllTargets: [...childFirstTargets, parent]
  }
}
