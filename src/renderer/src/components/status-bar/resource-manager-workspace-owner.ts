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
  collectorHostId: string,
  sampledHostId?: ExecutionHostId
): ExecutionHostId | null {
  const collectorHost = parseExecutionHostId(collectorHostId)
  if (!collectorHost) {
    return null
  }
  if (sampledHostId !== undefined && sampledHostId !== collectorHost.id) {
    return null
  }
  // Snapshot rows come from the collector's local-only PTY registry, not its SSH inventory.
  if (sampledHostId !== undefined || collectorHost.kind !== 'local') {
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
