import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

export type WorktreeAgentActivationRoute = {
  workspaceKey: string
  executionHostId: ExecutionHostId
  runtimeEnvironmentId: string | null
  runtimeEnvironmentRevision: number | null
}

export function worktreeAgentActivationRouteKey(route: WorktreeAgentActivationRoute): string {
  return JSON.stringify([
    route.executionHostId,
    route.runtimeEnvironmentId,
    route.runtimeEnvironmentRevision,
    route.workspaceKey
  ])
}

export function runtimeTargetForActivationRoute(
  route: WorktreeAgentActivationRoute
): RuntimeClientTarget | null {
  const host = parseExecutionHostId(route.executionHostId)
  if (!host) {
    return null
  }
  if (host.kind === 'runtime') {
    return route.runtimeEnvironmentId === host.environmentId
      ? { kind: 'environment', environmentId: host.environmentId }
      : null
  }
  return route.runtimeEnvironmentId === null ? { kind: 'local' } : null
}
