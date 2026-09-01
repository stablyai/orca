import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { withoutErasedRequiredWorktreeFields } from './worktree-meta-erasure-guard'

export function findWorktreeById(
  worktreesByRepo: Record<string, Worktree[]>,
  worktreeId: string
): Worktree | undefined {
  for (const worktrees of Object.values(worktreesByRepo)) {
    const match = worktrees.find((worktree) => worktree.id === worktreeId)
    if (match) {
      return match
    }
  }

  return undefined
}

export function applyWorktreeUpdates(
  worktreesByRepo: Record<string, Worktree[]>,
  worktreeId: string,
  rawUpdates: Partial<WorktreeMeta>
): Record<string, Worktree[]> {
  const updates = withoutErasedRequiredWorktreeFields(rawUpdates)
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const worktrees = worktreesByRepo[repoId]
  if (!worktrees) {
    return worktreesByRepo
  }

  let changed = false
  const nextWorktrees = worktrees.map((worktree) => {
    if (worktree.id !== worktreeId) {
      return worktree
    }

    changed = true
    return { ...worktree, ...updates }
  })
  if (!changed) {
    return worktreesByRepo
  }

  return { ...worktreesByRepo, [repoId]: nextWorktrees }
}
