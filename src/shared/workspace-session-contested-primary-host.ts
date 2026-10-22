import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import { workspaceSessionPartitionHostId } from './workspace-session-partition-owner'

/** The partition a host's session rows live in: every non-'local' host owns its own. */
export function sessionPartitionHostFor(hostId: ExecutionHostId): ExecutionHostId {
  return workspaceSessionPartitionHostId(hostId)
}

/** Distinct partitions a set of claimants spans. Fewer than two means persistence cannot tell the
 *  claimants apart, so the id keeps its uncontested routing. */
export function contestedPartitionHosts(claimed: Iterable<ExecutionHostId>): ExecutionHostId[] {
  return [...new Set([...claimed].map(sessionPartitionHostFor))]
}

/** Stable owner of a contested id: 'local' when it is a claimant, then any non-runtime host, then
 *  the lowest host id.
 *  Deliberately not the active host — a primary that followed navigation would migrate the same
 *  rows between partitions on every workspace switch. And deliberately not plain sort order once
 *  'local' is out: a `runtime:` environment id rotates across relay restarts, so ranking it last
 *  keeps a re-created environment from taking a stable host's rows into its partition. */
export function pickPrimaryHostForClaims(hostIds: Iterable<ExecutionHostId>): ExecutionHostId {
  const sorted = [...hostIds].sort()
  return (
    sorted.find((hostId) => hostId === LOCAL_EXECUTION_HOST_ID) ??
    sorted.find((hostId) => parseExecutionHostId(hostId)?.kind !== 'runtime') ??
    sorted[0] ??
    LOCAL_EXECUTION_HOST_ID
  )
}
