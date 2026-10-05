import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'

export type ResourceManagerWorktreeTarget = Pick<Worktree, 'id' | 'hostId'>

export function resolveResourceManagerWorktreeTarget(
  worktreeId: string,
  worktrees: readonly ResourceManagerWorktreeTarget[],
  hostId?: ExecutionHostId
): ResourceManagerWorktreeTarget | null {
  let target: ResourceManagerWorktreeTarget | null = null
  for (const worktree of worktrees) {
    if (
      worktree.id !== worktreeId ||
      (hostId && (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID) !== hostId)
    ) {
      continue
    }
    if (target) {
      return null
    }
    target = worktree
  }
  return target
}
