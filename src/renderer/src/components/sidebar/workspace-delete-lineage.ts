import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoHostSummaries } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { getProjectedWorktreeLineageChildrenByParentId } from './worktree-lineage-projection'

type WorkspaceDeleteLineage = {
  descendants: Worktree[]
  deleteAllTargets: Worktree[]
}

export function getWorkspaceDeleteLineage(
  parent: Worktree,
  worktrees: readonly Worktree[],
  lineageById: Record<string, WorktreeLineage>,
  repos?: readonly Repo[]
): WorkspaceDeleteLineage {
  // Why (STA-4343): lineage is recorded against the bare `repoId::path` id, so a
  // colliding id resolves to one of two hosts here. A lineage child of a workspace
  // on host X is on host X, so prefer the parent's host — otherwise "delete all"
  // could route a descendant's removal at the other machine's checkout.
  const worktreeById = new Map<string, Worktree>()
  const owners = repos ? getRepoHostSummaries(repos) : null
  const hostFor = (worktree: Worktree) => {
    const owner = owners?.get(worktree.repoId)
    return worktree.hostId ?? (owner?.count === 1 ? owner.onlyHostId : undefined)
  }
  const parentHost = hostFor(parent)
  for (const worktree of worktrees) {
    if (
      (owners && !parentHost) ||
      hostFor(worktree) !== parentHost ||
      worktree.runtimeOwnerEnvironmentId !== parent.runtimeOwnerEnvironmentId
    ) {
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
    // Why: if a child workspace physically lives inside the parent directory,
    // deleting descendants first prevents Git's force-delete path from removing
    // the child as untracked content under the parent.
    deleteAllTargets: [...childFirstTargets, parent]
  }
}
