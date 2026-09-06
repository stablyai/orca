import { parseExecutionHostId, type ExecutionHostId } from './execution-host'

/**
 * What a bounded listing did and did not cover, by execution host. An absent scope means the
 * host is too old to report one — not that it covered everything. See
 * `docs/reference/ssh-execution-boundary.md`: a listing is only evidence about the hosts it
 * actually covered, so an empty answer for a host that is missing here proves nothing.
 */
export type RuntimeListingHostScope = {
  hostIds: ExecutionHostId[]
  omittedHostIds: ExecutionHostId[]
}

/**
 * Whether the answering runtime enumerated every host its listing owed coverage for.
 *
 * `omittedHostIds` is a disclosure list and deliberately over-names — `omitted-host-scope-selectors.ts`
 * keeps ids for servers that are no longer paired so a caller can still see the gap. That makes it the
 * wrong input for a completeness gate, which needs "coverage owed and not delivered". The two jobs pull
 * in opposite directions, and reading the disclosure list as the gate latched every remote pane on any
 * client that had ever paired outward (#18595).
 *
 * A `runtime:` host is never owed coverage by the runtime answering: a paired runtime is a peer with its
 * own control plane, reached with `--environment`, and this runtime has no paired-runtime PTY provider to
 * have queried. Its terminals are its own answer to give, so its presence here is disclosure, not a gap.
 */
export function hostScopeCensusIsComplete(scope: RuntimeListingHostScope | undefined): boolean {
  // A host too old to publish a scope cannot claim one; absence is never completeness.
  if (scope === undefined) {
    return false
  }
  // A listing that covered no host proves nothing, and an unreadable coverage claim is not a
  // claim: `isTerminalListResult` checks only that `hostIds` is an array, so at least one covered
  // id has to be legible before the claim can be believed. Deliberately "at least one" rather than
  // "all": a host that later gains a kind this client cannot parse would otherwise report an
  // incomplete census forever, which is the bug this predicate exists to stop.
  if (!scope.hostIds.some((hostId) => parseExecutionHostId(hostId))) {
    return false
  }
  return scope.omittedHostIds.every((hostId) => parseExecutionHostId(hostId)?.kind === 'runtime')
}
