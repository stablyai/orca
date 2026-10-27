import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import { workspaceSessionPartitionHostId } from './workspace-session-partition-owner'

export function sessionPartitionHostFor(hostId: ExecutionHostId): ExecutionHostId {
  return workspaceSessionPartitionHostId(hostId)
}

/** Fewer than two distinct partitions cannot distinguish claimants, so preserve uncontested routing. */
export function contestedPartitionHosts(claimed: Iterable<ExecutionHostId>): ExecutionHostId[] {
  return [...new Set([...claimed].map(sessionPartitionHostFor))]
}

/** Choose local, then a non-runtime host, then the lowest ID. Navigation must not migrate rows; rank rotating runtime IDs last so relay restarts cannot steal stable-host ownership. */
export function pickPrimaryHostForClaims(hostIds: Iterable<ExecutionHostId>): ExecutionHostId {
  const sorted = [...hostIds].sort()
  return (
    sorted.find((hostId) => hostId === LOCAL_EXECUTION_HOST_ID) ??
    sorted.find((hostId) => parseExecutionHostId(hostId)?.kind !== 'runtime') ??
    sorted[0] ??
    LOCAL_EXECUTION_HOST_ID
  )
}
