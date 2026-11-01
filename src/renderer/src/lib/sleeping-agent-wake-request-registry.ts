import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

type SleepingAgentWakeRecord = Pick<SleepingAgentSessionRecord, 'paneKey'>

// Why a store-free leaf: pane-ownership predicates read this registry synchronously and must not
// drag the app store's module graph (and its cycles) into theirs.
// Why record identity: a replaced or cleared record drops its request, so a stale ask never wakes a later sleep.
const requestedRecords = new WeakSet<SleepingAgentWakeRecord>()

/** Marks a record whose pane owes its agent a wake when the pane mounts. */
export function markSleepingAgentWakeRequest(record: SleepingAgentWakeRecord): void {
  requestedRecords.add(record)
}

/** Whether the dispatcher promised this record's pane a wake on mount — an ownership proof for the resume sweep. */
export function hasSleepingAgentWakeRequest(record: SleepingAgentWakeRecord): boolean {
  return requestedRecords.has(record)
}

export function takeSleepingAgentWakeRequest(record: SleepingAgentWakeRecord): boolean {
  return requestedRecords.delete(record)
}
