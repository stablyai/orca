import {
  getSettingsFocusedExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

export type WorktreeOperationRoute = {
  executionHostId: ExecutionHostId | null
  runtimeEnvironmentId: string | null
}

export type WorktreeOperationRouteResolution =
  | { kind: 'resolved'; route: WorktreeOperationRoute }
  | { kind: 'ambiguous' }
  | { kind: 'missing' }

function routeMatchesFocusedHost(
  route: WorktreeOperationRoute,
  focusedHostId: ExecutionHostId
): boolean {
  if (route.executionHostId === focusedHostId) {
    return true
  }
  // Why: HUB-owned SSH rows keep executionHostId=ssh:* while transport ownership is the runtime.
  const focused = parseExecutionHostId(focusedHostId)
  return (
    focused?.kind === 'runtime' &&
    route.runtimeEnvironmentId != null &&
    route.runtimeEnvironmentId === focused.environmentId
  )
}

// Why: same worktree/repo id can project on multiple hosts; only collapse when focus selects one (#10491).
export function preferFocusedRoute(
  routes: Iterable<WorktreeOperationRoute>,
  settings: { activeRuntimeEnvironmentId?: string | null } | null | undefined
): WorktreeOperationRoute | null {
  const candidates = [...routes]
  if (candidates.length === 0) {
    return null
  }
  if (candidates.length === 1) {
    return candidates[0]
  }
  const focusedHostId = getSettingsFocusedExecutionHostId(settings)
  const focusedMatches = candidates.filter((route) => routeMatchesFocusedHost(route, focusedHostId))
  return focusedMatches.length === 1 ? focusedMatches[0] : null
}

export function resolveFromCandidateRoutes(
  routes: Map<string, WorktreeOperationRoute>,
  settings: { activeRuntimeEnvironmentId?: string | null } | null | undefined
): WorktreeOperationRouteResolution {
  if (routes.size === 0) {
    return { kind: 'missing' }
  }
  const preferred = preferFocusedRoute(routes.values(), settings)
  if (preferred) {
    return { kind: 'resolved', route: preferred }
  }
  return routes.size > 1 ? { kind: 'ambiguous' } : { kind: 'missing' }
}

export function addOperationRoute(
  routes: Map<string, WorktreeOperationRoute>,
  route: WorktreeOperationRoute | null
): void {
  if (!route) {
    return
  }
  routes.set(JSON.stringify(route), route)
}
