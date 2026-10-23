import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../execution-host'
import { isEphemeralSetupTerminalWorktreeId } from '../ephemeral-setup-terminal-worktree-id'
import { isFloatingWorkspaceId } from '../floating-workspace-worktree'

/**
 * Workspace ids with no repo or folder row behind them. Each store keeps their metadata for its
 * own machine, so they are never another host's state (#31498).
 */
export function isLocalOnlyWorktreeMetaId(worktreeId: string): boolean {
  return isFloatingWorkspaceId(worktreeId) || isEphemeralSetupTerminalWorktreeId(worktreeId)
}

/** The host a metadata row for `worktreeId` belongs to when a caller names `executionHostId`. */
export function worktreeMetaHostFor(
  worktreeId: string,
  executionHostId: ExecutionHostId
): ExecutionHostId {
  return isLocalOnlyWorktreeMetaId(worktreeId) ? LOCAL_EXECUTION_HOST_ID : executionHostId
}
