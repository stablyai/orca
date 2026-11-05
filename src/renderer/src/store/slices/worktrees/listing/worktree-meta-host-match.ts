import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'

/** Match unstamped rows as local like findKnownWorktreeById or optimistic renames silently wait for refetch. */
export function worktreeRowMatchesMetaHost(
  worktree: { hostId?: ExecutionHostId },
  executionHostId: ExecutionHostId | undefined
): boolean {
  return (
    executionHostId === undefined ||
    worktree.hostId === executionHostId ||
    (worktree.hostId === undefined && executionHostId === LOCAL_EXECUTION_HOST_ID)
  )
}
