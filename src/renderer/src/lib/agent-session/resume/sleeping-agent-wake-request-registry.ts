import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

type SleepingAgentWakeRecord = Pick<SleepingAgentSessionRecord, 'paneKey'>

// Why a store-free leaf: pane-ownership predicates read this registry synchronously and must not
// drag the app store's module graph (and its cycles) into theirs.
// Why record identity: a replaced or cleared record drops its request, so a stale ask never wakes a later sleep.
const requestedRecords = new WeakMap<SleepingAgentWakeRecord, number>()

// Why a bound: the mark is an ownership proof only while the pane is on its way to mounting. A pane
// that never mounts (deferred admission, failed render) must not keep the sweep from resuming its
// record forever, so the proof holds for a bounded window from the first request and then lapses.
const WAKE_REQUEST_TTL_MS = 5 * 60_000

/** Marks a record whose pane owes its agent a wake when the pane mounts. The first request wins: a
 * re-dispatch must not refresh the bound, or a pane that never mounts would push every later sweep
 * past it forever; a lapsed request stays lapsed until its record is consumed or replaced. */
export function markSleepingAgentWakeRequest(record: SleepingAgentWakeRecord): void {
  if (!requestedRecords.has(record)) {
    requestedRecords.set(record, Date.now())
  }
}

/** Whether the dispatcher promised this record's pane a wake on mount — an ownership proof for the resume sweep. */
export function hasSleepingAgentWakeRequest(record: SleepingAgentWakeRecord): boolean {
  const requestedAt = requestedRecords.get(record)
  // Why the entry stays: an expired request must keep refusing re-marks, so the sweep's fallback fork can run.
  return requestedAt !== undefined && Date.now() - requestedAt <= WAKE_REQUEST_TTL_MS
}

export function takeSleepingAgentWakeRequest(record: SleepingAgentWakeRecord): boolean {
  return requestedRecords.delete(record)
}
