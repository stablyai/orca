import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../execution-host/execution-host'
import { isEphemeralSetupTerminalWorktreeId } from '../../workspace-setup/ephemeral-setup-terminal-worktree-id'
import { isFloatingWorkspaceId } from '../../workspace/identity/floating-workspace-worktree'

/** Rows without repo/folder ownership stay machine-local, never another host’s state (#31498). */
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
