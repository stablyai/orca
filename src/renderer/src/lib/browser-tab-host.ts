import { parseExecutionHostId } from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/types'
import type { WorktreeOperationRouteResolution } from './worktree-operation-route'

export type BrowserTabHost = NonNullable<GlobalSettings['browserTabHost']>
export type BrowserTabTarget =
  | { kind: 'local' }
  | { kind: 'runtime'; runtimeEnvironmentId: string }
  | { kind: 'unavailable' }

/** Returns whether this client can own a local Electron browser surface. */
export function isBrowserTabHostLockedToWorkspace(): boolean {
  return (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
}

/** Resolves the effective host while keeping paired web clients runtime-owned. */
export function resolveBrowserTabHost(
  configuredHost: GlobalSettings['browserTabHost']
): BrowserTabHost {
  return isBrowserTabHostLockedToWorkspace() ? 'workspace' : (configuredHost ?? 'local')
}

/** Resolves one creation target without treating uncertain workspace ownership as local. */
export function resolveBrowserTabTarget(
  configuredHost: GlobalSettings['browserTabHost'],
  route: WorktreeOperationRouteResolution
): BrowserTabTarget {
  if (resolveBrowserTabHost(configuredHost) === 'local') {
    return { kind: 'local' }
  }
  if (route.kind !== 'resolved') {
    return { kind: 'unavailable' }
  }
  const runtimeEnvironmentId = route.route.runtimeEnvironmentId?.trim()
  if (runtimeEnvironmentId) {
    return { kind: 'runtime', runtimeEnvironmentId }
  }
  const executionHost = parseExecutionHostId(route.route.executionHostId)
  if (
    !isBrowserTabHostLockedToWorkspace() &&
    (executionHost?.kind === 'local' || executionHost?.kind === 'ssh')
  ) {
    return { kind: 'local' }
  }
  return { kind: 'unavailable' }
}
