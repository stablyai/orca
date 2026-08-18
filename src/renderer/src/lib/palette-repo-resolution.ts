import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../shared/repo-host-identity'
import type { Worktree } from '../../../shared/worktree/types'

/** Resolve the repo that owns a worktree, preserving host collisions. */
export function resolvePaletteRepoForWorktree<T extends { displayName?: string | null }>(
  worktree: Pick<Worktree, 'id' | 'repoId' | 'hostId'>,
  repoMap: ReadonlyMap<string, T>,
  repoMapByHostIdentity?: ReadonlyMap<string, T>
): T | undefined {
  return (
    repoMapByHostIdentity?.get(
      getRepoHostIdentityForParts(worktree.repoId, worktree.hostId ?? LOCAL_EXECUTION_HOST_ID)
    ) ?? repoMap.get(worktree.repoId)
  )
}

export function isPaletteCurrentWorktree(
  worktree: Pick<Worktree, 'id' | 'hostId'>,
  activeWorktreeId: string | null,
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
): boolean {
  if (activeWorkspaceExecutionHostId === undefined) {
    return activeWorktreeId === worktree.id
  }
  return (
    activeWorktreeId === worktree.id &&
    (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID) ===
      (activeWorkspaceExecutionHostId ?? LOCAL_EXECUTION_HOST_ID)
  )
}
