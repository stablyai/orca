import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

type SleepingAgentWakeRecord = Pick<SleepingAgentSessionRecord, 'paneKey'>

// Why a store-free leaf: pane-ownership predicates read this registry synchronously and must not
// drag the app store's module graph (and its cycles) into theirs.
// Why record identity: a replaced or cleared record drops its request, so a stale ask never wakes a later sleep.
const requestedRecords = new WeakMap<SleepingAgentWakeRecord, number>()

// Why a bound: the mark is an ownership proof only while the pane is on its way to mounting. A pane
// that never mounts (deferred admission, failed render) must not keep the sweep from resuming its
// record forever, so each dispatch refreshes the mark and an unrefreshed one lapses.
const WAKE_REQUEST_TTL_MS = 5 * 60_000

/** Marks a record whose pane owes its agent a wake when the pane mounts. */
export function markSleepingAgentWakeRequest(record: SleepingAgentWakeRecord): void {
  requestedRecords.set(record, Date.now())
}

/** Whether the dispatcher promised this record's pane a wake on mount — an ownership proof for the resume sweep. */
export function hasSleepingAgentWakeRequest(record: SleepingAgentWakeRecord): boolean {
  const requestedAt = requestedRecords.get(record)
  if (requestedAt === undefined) {
    return false
  }
  if (Date.now() - requestedAt > WAKE_REQUEST_TTL_MS) {
    requestedRecords.delete(record)
    return false
  }
  return true
}

export function takeSleepingAgentWakeRequest(record: SleepingAgentWakeRecord): boolean {
  return requestedRecords.delete(record)
}
