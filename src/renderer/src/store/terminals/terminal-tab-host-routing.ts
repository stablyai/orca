import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { getRemoteConnectionIdForWorktree } from './terminal-workspace-routing'

export function resolveTerminalTabHostRouting(
  s: Parameters<typeof getRemoteConnectionIdForWorktree>[0],
  worktreeId: string,
  explicitHostId: ExecutionHostId | undefined
) {
  // Why: a tab placed on another host runs there; the worktree's shell facts don't apply.
  const remoteConnectionId = explicitHostId ? null : getRemoteConnectionIdForWorktree(s, worktreeId)
  const isRemoteWorktree = explicitHostId
    ? explicitHostId !== LOCAL_EXECUTION_HOST_ID
    : Boolean(remoteConnectionId)
  return { explicitHostId, remoteConnectionId, isRemoteWorktree }
}
