import type { RuntimeHostStatusSnapshot } from './runtime-host-status'
import type { RuntimeStatus } from './runtime-types'

/** Separate live answers, unverifiable probes, refusals and retired pairings: nullable store status conflates them.
 * Loss of contact never proves exit; only refusal/retirement positively withdraw prior facts (ssh-execution-boundary.md). */
export type RuntimeHostContact =
  | { verdict: 'live'; status: RuntimeStatus }
  | {
      verdict: 'unverifiable'
      reason: RuntimeHostContactUnverifiableReason
      lastAnswer: RuntimeStatus | null
    }
  | { verdict: 'refused'; lastAnswer: RuntimeStatus | null }
  | { verdict: 'retired'; lastAnswer: RuntimeStatus | null }

/** An unreachable host may stay never-asked forever; distinguish that from a handshake in flight to keep actions available. */
export type RuntimeHostContactUnverifiableReason =
  | 'never-asked'
  | 'checking'
  | 'probe-failed'
  | 'transport-connecting'
  | 'transport-down'

/** Retain the last host answer across contact loss; null only if none exists. Callers decide which facts remain usable. */
export function lastRuntimeHostAnswer(contact: RuntimeHostContact): RuntimeStatus | null {
  return contact.verdict === 'live' ? contact.status : contact.lastAnswer
}

/** The answer only while it is current, for decisions that must not act on a stale fact. */
export function liveRuntimeHostStatus(contact: RuntimeHostContact): RuntimeStatus | null {
  return contact.verdict === 'live' ? contact.status : null
}

/** True only for the host's own terminal verdicts — the one state that may withdraw a fact. */
export function isRuntimeHostContactRevokedVerdict(contact: RuntimeHostContact): boolean {
  return contact.verdict === 'refused' || contact.verdict === 'retired'
}

/** Transport loss outranks in-flight probing; ready transport with a failed probe means runtime-layer unreachability.
 * The parity suite pins this ordering to connection-state derivation. */
export function runtimeHostContactFromSnapshot(
  snapshot: RuntimeHostStatusSnapshot,
  entryStatus: RuntimeStatus | null = snapshot.status
): RuntimeHostContact {
  const lastAnswer = snapshot.status
  if (snapshot.retired) {
    return { verdict: 'retired', lastAnswer }
  }
  if (snapshot.verification === 'blocked') {
    return { verdict: 'refused', lastAnswer }
  }
  if (snapshot.transport === 'disconnected') {
    return { verdict: 'unverifiable', reason: 'transport-down', lastAnswer }
  }
  if (snapshot.verification === 'checking' && !entryStatus) {
    return { verdict: 'unverifiable', reason: 'checking', lastAnswer }
  }
  if (snapshot.transport === 'ready' && snapshot.verification !== 'verified') {
    return { verdict: 'unverifiable', reason: 'probe-failed', lastAnswer }
  }
  if (snapshot.verification === 'verified' && entryStatus) {
    return { verdict: 'live', status: entryStatus }
  }
  if (snapshot.transport === 'connecting') {
    return { verdict: 'unverifiable', reason: 'transport-connecting', lastAnswer }
  }
  return { verdict: 'unverifiable', reason: 'never-asked', lastAnswer }
}

/** Explicit contact can express failures before any snapshot; derive from snapshot only for unconverted writers. */
export function runtimeHostContactForEntry(
  entry:
    | {
        status: RuntimeStatus | null
        contact?: RuntimeHostContact
        snapshot?: RuntimeHostStatusSnapshot
      }
    | null
    | undefined
): RuntimeHostContact {
  if (!entry) {
    return { verdict: 'unverifiable', reason: 'never-asked', lastAnswer: null }
  }
  if (entry.contact) {
    return entry.contact
  }
  if (entry.snapshot) {
    return runtimeHostContactFromSnapshot(entry.snapshot, entry.status)
  }
  return entry.status
    ? { verdict: 'live', status: entry.status }
    : { verdict: 'unverifiable', reason: 'probe-failed', lastAnswer: null }
}
