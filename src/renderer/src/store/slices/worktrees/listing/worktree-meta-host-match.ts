import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'

/**
 * Mirror findKnownWorktreeById: an unstamped row belongs to the local host. A stricter test
 * silently no-ops the optimistic write, so a rename appears to do nothing until the next refetch.
 */
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
