import type {
  RemoteRuntimeSnapshotRetryCause,
  RemoteRuntimeSnapshotHostRetryCause,
  RemoteRuntimeSnapshotOutcome,
  RemoteRuntimeSnapshotAvailability,
  RemoteRuntimeSnapshotInfo
} from './remote-terminal-snapshot-contracts'

const HOST_ANSWERED_SNAPSHOT_RETRY_CAUSES = new Set<RemoteRuntimeSnapshotRetryCause>([
  'host-pending-output-overflowed',
  'host-no-serializable-buffer'
])

/** Callers budget host answers separately from local gates; only the former cost the host a request. */
export function isHostAnsweredSnapshotRetryCause(
  cause: RemoteRuntimeSnapshotRetryCause
): cause is RemoteRuntimeSnapshotHostRetryCause {
  return HOST_ANSWERED_SNAPSHOT_RETRY_CAUSES.has(cause)
}

export function retryWorthySnapshotOutcome(
  cause: RemoteRuntimeSnapshotRetryCause
): RemoteRuntimeSnapshotOutcome {
  return { availability: { kind: 'retry-worthy', cause }, snapshot: null }
}

export function classifySnapshotAvailability(
  clientOverflowed: boolean,
  info: RemoteRuntimeSnapshotInfo | null
): RemoteRuntimeSnapshotAvailability {
  if (clientOverflowed) {
    return { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' }
  }
  if (info?.unavailable === 'pending-output-overflowed') {
    return { kind: 'retry-worthy', cause: 'host-pending-output-overflowed' }
  }
  if (info?.unavailable === 'no-serializable-buffer') {
    return { kind: 'retry-worthy', cause: 'host-no-serializable-buffer' }
  }
  // Why: a truncated reply with no stated reason can only come from a host that predates `unavailable`.
  if (info?.truncated === true) {
    return { kind: 'unknown-legacy-host' }
  }
  return { kind: 'snapshot' }
}
