import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { resolveOwner } from '@/lib/workspace/ownership/resolve-owner'
import {
  getConnectionIdFromState,
  getConnectionIdForWorktreeCopy
} from '@/lib/workspace/ownership/connection-owner-resolution'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from './workspace/ownership/worktree-runtime-owner'
import type {
  WorktreeHostFactsState,
  ExecutionHostTarget
} from '@/runtime/hosts/platform/execution-host-facts'

export function worktreeExecutionHostTarget(
  state: Omit<WorktreeHostFactsState, 'settings'>,
  worktreeId: string,
  hostId: string,
  executionHostId?: ExecutionHostId
): ExecutionHostTarget {
  const host = parseExecutionHostId(executionHostId ?? hostId)
  const owner = executionHostId
    ? resolveOwner(state, { workspaceId: worktreeId, hostId: executionHostId })
    : undefined
  return {
    host,
    nestedSshTargetId:
      host?.kind === 'runtime'
        ? ((executionHostId
            ? getConnectionIdForWorktreeCopy(state, worktreeId, executionHostId)
            : getConnectionIdFromState(state, worktreeId)) ?? null)
        : null,
    sshOwnerEnvironmentId:
      host?.kind === 'ssh'
        ? executionHostId
          ? owner?.kind === 'resolved' && owner.owner.endpoint.kind === 'environment'
            ? owner.owner.endpoint.environmentId
            : null
          : runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
        : null
  }
}
