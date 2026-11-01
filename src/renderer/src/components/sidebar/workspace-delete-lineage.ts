import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getProjectedWorktreeLineageChildrenByParentId } from '../../../../shared/sidebar-list/worktree-lineage-projection'

type WorkspaceDeleteLineage = {
  descendants: Worktree[]
  deleteAllTargets: Worktree[]
}

export function getWorkspaceDeleteLineage(
  parent: Worktree,
  worktrees: readonly Worktree[],
  lineageById: Record<string, WorktreeLineage>
): WorkspaceDeleteLineage {
  // Lineage IDs omit hosts; prefer the parent’s host so descendant deletion cannot reach another machine.
  const worktreeById = new Map<string, Worktree>()
  for (const worktree of worktrees) {
    const claimed = worktreeById.get(worktree.id)
    if (claimed && claimed.hostId === parent.hostId && worktree.hostId !== parent.hostId) {
      continue
    }
    worktreeById.set(worktree.id, worktree)
  }
  const lineageForSelectedRows: Record<string, WorktreeLineage> = {}
  for (const worktree of worktreeById.values()) {
    const projected = lineageById[worktree.id]
    const inline = (worktree as Worktree & { lineage?: WorktreeLineage | null }).lineage
    const lineage = projected?.worktreeInstanceId === worktree.instanceId ? projected : inline
    if (lineage) {
      lineageForSelectedRows[worktree.id] = lineage
    }
  }
  const childrenByParentId = getProjectedWorktreeLineageChildrenByParentId(
    lineageForSelectedRows,
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
    // Delete nested children first so Git cannot remove them as untracked content under the parent.
    deleteAllTargets: [...childFirstTargets, parent]
  }
}
