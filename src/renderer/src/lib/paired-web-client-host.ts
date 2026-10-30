import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { isPairedWebClientWindow } from './desktop-window-chrome'

type HostRouteState = { runtimeEnvironments?: readonly { id: string }[] }

/** Browser clients own no PTYs/files/browser runtime; their sole paired server serves even routes called local. */
export function getPairedWebClientEnvironmentId(state: HostRouteState): string | null {
  if (!isPairedWebClientWindow()) {
    return null
  }
  const environments = state.runtimeEnvironments ?? []
  return environments.length === 1 ? environments[0].id.trim() || null : null
}

/** A route with no server, on a web client, goes through its server; `local` there is the server's own. */
export function onPairedWebClientHost<
  T extends { executionHostId: ExecutionHostId | null; runtimeEnvironmentId: string | null }
>(state: HostRouteState, route: T): T {
  const environmentId = route.runtimeEnvironmentId ? null : getPairedWebClientEnvironmentId(state)
  const host = parseExecutionHostId(route.executionHostId)
  // Why: an unparseable host is the never-routable sentinel; it stays refused.
  if (!environmentId || (route.executionHostId && !host)) {
    return route
  }
  return {
    ...route,
    executionHostId: host?.kind === 'ssh' ? host.id : toRuntimeExecutionHostId(environmentId),
    runtimeEnvironmentId: environmentId
  }
}
