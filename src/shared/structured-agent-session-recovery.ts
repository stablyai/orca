import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'

// Eight probes retain the existing backoff: 79 seconds of delays, plus RPC latency.
export const STRUCTURED_SESSION_RECOVERY_ATTEMPTS = 8

export type StructuredAgentSessionRecovery = {
  attempts: number
  nextProbeAt: number | null
  parkedReason: 'budget-exhausted' | null
}

export function parseStructuredAgentSessionRecovery(
  value: unknown
): StructuredAgentSessionRecovery | undefined {
  if (value === undefined) {
    return undefined
  }
  const recovery = value as Partial<StructuredAgentSessionRecovery> | null
  if (
    recovery &&
    Number.isInteger(recovery.attempts) &&
    recovery.attempts! >= 0 &&
    recovery.attempts! <= STRUCTURED_SESSION_RECOVERY_ATTEMPTS &&
    (recovery.nextProbeAt === null ||
      (typeof recovery.nextProbeAt === 'number' && Number.isFinite(recovery.nextProbeAt))) &&
    (recovery.parkedReason === null || recovery.parkedReason === 'budget-exhausted')
  ) {
    return recovery as StructuredAgentSessionRecovery
  }
  // Preserve uncertain payloads, but do not grant more automatic work to malformed budgets.
  return {
    attempts: STRUCTURED_SESSION_RECOVERY_ATTEMPTS,
    nextProbeAt: null,
    parkedReason: 'budget-exhausted'
  }
}

export function advanceStructuredAgentSessionRecovery(
  entry: StructuredAgentSessionOutboxEntry,
  now: number
): StructuredAgentSessionOutboxEntry {
  if (entry.state !== 'unconfirmed' || entry.retryAfterUnknownSubmittedAt !== null) {
    return entry
  }
  const recovery = entry.recovery ?? { attempts: 0, nextProbeAt: null, parkedReason: null }
  if (recovery.parkedReason) {
    return entry
  }
  if (recovery.nextProbeAt !== null) {
    return recovery.nextProbeAt > now
      ? entry
      : { ...entry, state: 'queued', recovery: { ...recovery, nextProbeAt: null } }
  }
  return {
    ...entry,
    recovery:
      recovery.attempts >= STRUCTURED_SESSION_RECOVERY_ATTEMPTS
        ? { ...recovery, parkedReason: 'budget-exhausted' }
        : {
            attempts: recovery.attempts + 1,
            nextProbeAt: now + Math.min(1000 * 2 ** recovery.attempts, 16000),
            parkedReason: null
          }
  }
}

export function resumeStructuredAgentSessionRecovery(
  entry: StructuredAgentSessionOutboxEntry
): StructuredAgentSessionOutboxEntry {
  return entry.state === 'unconfirmed' && entry.retryAfterUnknownSubmittedAt === null
    ? { ...entry, recovery: { attempts: 0, nextProbeAt: null, parkedReason: null } }
    : entry
}
