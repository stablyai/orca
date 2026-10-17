import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../shared/remote-runtime-pty-id'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'

export function resolveTerminalWorktreeSleepOwner(
  state: WorktreeOperationRouteState,
  worktreeId: string | null,
  ptyId: string | null | undefined
): ExecutionHostId | null {
  if (!worktreeId) {
    return null
  }
  if (ptyId && isRemoteRuntimePtyId(ptyId)) {
    const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId
    return environmentId ? toRuntimeExecutionHostId(environmentId) : null
  }
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  return resolution.kind === 'resolved' ? resolution.route.executionHostId : null
}
