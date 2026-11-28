import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

type SleepingAgentWakeRecord = Pick<SleepingAgentSessionRecord, 'paneKey'>

// Store-free so ownership checks stay sync; keyed by record so a replaced record drops its ask.
const requestedRecords = new WeakMap<SleepingAgentWakeRecord, number>()

// Bounded: a pane that never mounts must not block the sweep from resuming its record forever.
const WAKE_REQUEST_TTL_MS = 5 * 60_000

/** First request wins: a re-dispatch must not extend the bound past a pane that never mounts. */
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
