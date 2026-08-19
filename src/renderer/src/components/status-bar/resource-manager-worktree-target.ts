import type { Worktree } from '../../../../shared/worktree/types'

export type ResourceManagerWorktreeTarget = Pick<Worktree, 'id' | 'hostId'>

export function resolveResourceManagerWorktreeTarget(
  worktreeId: string,
  worktrees: readonly ResourceManagerWorktreeTarget[]
): ResourceManagerWorktreeTarget | null {
  let target: ResourceManagerWorktreeTarget | null = null
  for (const worktree of worktrees) {
    if (worktree.id !== worktreeId) {
      continue
    }
    if (target) {
      return null
    }
    target = worktree
  }
  return target
}
