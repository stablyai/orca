import { parseExecutionHostId, type ExecutionHostId } from './execution-host'

/** Bounded listing evidence applies only to covered hosts; absent scopes on old hosts prove no coverage
 * (docs/reference/ssh-execution-boundary.md). */
export type RuntimeListingHostScope = {
  hostIds: ExecutionHostId[]
  omittedHostIds: ExecutionHostId[]
}

/** omittedHostIds discloses even retired peers, not coverage owed. Paired runtime peers own their control planes
 * and are never this runtime’s enumeration duty; counting them as gaps latched remote panes (#18595). */
export function hostScopeCensusIsComplete(scope: RuntimeListingHostScope | undefined): boolean {
  // A host too old to publish a scope cannot claim one; absence is never completeness.
  if (scope === undefined) {
    return false
  }
  // Require a legible covered ID: validators only prove an array. Requiring all IDs legible would reject future host kinds forever.
  if (!scope.hostIds.some((hostId) => parseExecutionHostId(hostId))) {
    return false
  }
  return scope.omittedHostIds.every((hostId) => parseExecutionHostId(hostId)?.kind === 'runtime')
}
