import {
  WORKER_DOCK_FAILURE_LIMIT,
  WORKER_DOCK_FAILURE_MS,
  WORKER_DOCK_UNVERIFIED_READY_MS,
  type WorkerDockEntry
} from '../../../../../../../shared/orchestration/dock/worker-dock'

/** The current-work rule as far as a snapshot can tell: hosts predating currentOnly send every
 *  eligible record, so finished and older failures are dropped here; a current host's rows pass. */
export function currentOnOlderHosts(
  identities: readonly Pick<WorkerDockEntry, 'id' | 'state' | 'changedAt' | 'settlement'>[],
  now: number
): { kept: Set<string>; nextExpiry: number | undefined } {
  const kept = new Set<string>()
  const failures: { id: string; expires: number }[] = []
  let nextExpiry: number | undefined
  for (const row of identities) {
    if (row.state === 'saving') {
      continue
    }
    const failed = row.state === 'failed' || row.state === 'unexpected'
    if (!failed && row.state !== 'unavailable') {
      kept.add(row.id)
      continue
    }
    if (row.changedAt === null) {
      if (!failed) {
        kept.add(row.id)
      }
      continue
    }
    const expires =
      row.changedAt + (failed ? WORKER_DOCK_FAILURE_MS : WORKER_DOCK_UNVERIFIED_READY_MS)
    if (expires <= now || (failed && row.settlement === null)) {
      continue
    }
    if (failed) {
      failures.push({ id: row.id, expires })
    } else {
      kept.add(row.id)
      nextExpiry = Math.min(nextExpiry ?? expires, expires)
    }
  }
  // The newest failures also expire last, so a later pass over the kept rows drops the same ones.
  for (const row of failures
    .sort((a, b) => b.expires - a.expires)
    .slice(0, WORKER_DOCK_FAILURE_LIMIT)) {
    kept.add(row.id)
    nextExpiry = Math.min(nextExpiry ?? row.expires, row.expires)
  }
  return { kept, nextExpiry }
}
