import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteState
} from '../../lib/worktree-operation-route'

export function resolveResourceManagerWorkspaceExecutionHostId(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  collectorHostId: string
): ExecutionHostId | null {
  const collectorHost = parseExecutionHostId(collectorHostId)
  if (!collectorHost) {
    return null
  }
  if (collectorHost.kind !== 'local') {
    return collectorHost.id
  }
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  if (resolution.kind !== 'resolved') {
    return null
  }
  const routeHost = parseExecutionHostId(resolution.route.executionHostId)
  if (routeHost) {
    return routeHost.id
  }
  const runtimeEnvironmentId = resolution.route.runtimeEnvironmentId?.trim()
  return runtimeEnvironmentId ? toRuntimeExecutionHostId(runtimeEnvironmentId) : null
}
