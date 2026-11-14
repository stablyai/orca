import type { InstrumentedPane } from './echo-instrumentation'
import type { EchoCandidate } from './echo-observation'

const ECHO_TIMEOUT_MS = 2000
export const MAX_PENDING_ECHO_CANDIDATES = 64

export function trackIgnoredEchoDispatch(
  entry: InstrumentedPane,
  candidate: EchoCandidate,
  now: number
): void {
  if (entry.ignoredDispatches.length === 0) {
    entry.deferredNextDispatch = entry.nextDispatch
  }
  entry.nextDispatch = null
  candidate.status = 'unmatched-undispatched'
  entry.ignoredDispatches.push(candidate)
  if (entry.ignoredDispatches.length > MAX_PENDING_ECHO_CANDIDATES) {
    entry.ignoredDispatches.shift()
    entry.ignoredDispatchOverflowedAt = now
  }
}

export function clearEchoDispatchSelection(
  entry: InstrumentedPane,
  candidate: EchoCandidate
): void {
  if (entry.nextDispatch === candidate) {
    entry.nextDispatch = null
  }
  if (entry.deferredNextDispatch === candidate) {
    entry.deferredNextDispatch = null
  }
}

export function restoreDeferredEchoDispatch(entry: InstrumentedPane): void {
  const deferred = entry.deferredNextDispatch
  entry.deferredNextDispatch = null
  if (deferred && entry.undispatched.includes(deferred)) {
    entry.nextDispatch = deferred
  }
}

function drainTimedOutCandidates(
  candidates: EchoCandidate[],
  now: number,
  onDrop?: (candidate: EchoCandidate) => void
): number {
  let retained = 0
  let dropped = 0
  for (const candidate of candidates) {
    if (now - candidate.t0 > ECHO_TIMEOUT_MS) {
      dropped += 1
      onDrop?.(candidate)
    } else {
      candidates[retained] = candidate
      retained += 1
    }
  }
  candidates.length = retained
  return dropped
}

/** Removes inputs whose echo window elapsed and returns the unmatched count. */
export function drainTimedOutEchoCandidates(entry: InstrumentedPane, now: number): number {
  const hadIgnoredDispatches = entry.ignoredDispatches.length > 0
  drainTimedOutCandidates(entry.ignoredDispatches, now)
  const overflowExpired =
    entry.ignoredDispatchOverflowedAt !== null &&
    now - entry.ignoredDispatchOverflowedAt > ECHO_TIMEOUT_MS
  if (overflowExpired) {
    entry.ignoredDispatchOverflowedAt = null
  }
  if (
    (hadIgnoredDispatches || overflowExpired) &&
    entry.ignoredDispatches.length === 0 &&
    entry.ignoredDispatchOverflowedAt === null
  ) {
    restoreDeferredEchoDispatch(entry)
  }
  let dropped = drainTimedOutCandidates(entry.undispatched, now, (candidate) => {
    candidate.status = 'unmatched-undispatched'
    clearEchoDispatchSelection(entry, candidate)
  })
  const awaitingEchoDropped = drainTimedOutCandidates(entry.awaitingEcho, now, (candidate) => {
    candidate.status = 'unmatched-dispatched'
  })
  if (awaitingEchoDropped > 0) {
    entry.attributionGap = true
    dropped += awaitingEchoDropped
  }
  if (entry.parsingBatch) {
    const parsingDropped = drainTimedOutCandidates(
      entry.parsingBatch.candidates,
      now,
      (candidate) => {
        candidate.status = 'unmatched-dispatched'
      }
    )
    if (parsingDropped > 0) {
      entry.parsingBatch.hasAttributionGap = true
      dropped += parsingDropped
    }
  }
  for (const batch of entry.parsedBatches) {
    const parsedDropped = drainTimedOutCandidates(batch.candidates, now, (candidate) => {
      candidate.status = 'unmatched-dispatched'
    })
    if (parsedDropped > 0) {
      batch.hasAttributionGap = true
      dropped += parsedDropped
    }
  }
  if (dropped > 0) {
    entry.pendingCount -= dropped
    entry.parsedBatches = entry.parsedBatches.filter((batch) => batch.candidates.length > 0)
  }
  return dropped
}
