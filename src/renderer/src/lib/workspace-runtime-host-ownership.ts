import type { Worktree } from '../../../shared/types'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

export type WorkspaceRuntimeOwnerProjection = Pick<
  Worktree,
  'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'
>

function recordRuntimeHost(
  owners: Map<string, ExecutionHostId | null>,
  worktreeId: string,
  hostId: ExecutionHostId
): void {
  const existing = owners.get(worktreeId)
  owners.set(worktreeId, existing === undefined ? hostId : existing === hostId ? hostId : null)
}

export function indexWorkspaceRuntimeHostOwnership(
  worktreesByRepo: Record<string, readonly WorkspaceRuntimeOwnerProjection[]>
): {
  repoIdByWorktreeId: Map<string, string>
  runtimeHostIdByWorktreeId: Map<string, ExecutionHostId | null>
} {
  const repoIdByWorktreeId = new Map<string, string>()
  const runtimeHostIdByWorktreeId = new Map<string, ExecutionHostId | null>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      repoIdByWorktreeId.set(worktree.id, worktree.repoId)
      const runtimeOwner = worktree.runtimeOwnerEnvironmentId?.trim()
      if (runtimeOwner) {
        recordRuntimeHost(
          runtimeHostIdByWorktreeId,
          worktree.id,
          toRuntimeExecutionHostId(runtimeOwner)
        )
        continue
      }
      const parsedWorktreeHost = parseExecutionHostId(worktree.hostId)
      if (parsedWorktreeHost?.kind === 'runtime') {
        recordRuntimeHost(runtimeHostIdByWorktreeId, worktree.id, parsedWorktreeHost.id)
      }
    }
  }
  return { repoIdByWorktreeId, runtimeHostIdByWorktreeId }
}
