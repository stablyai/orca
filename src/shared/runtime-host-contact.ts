import type { RuntimeHostStatusSnapshot } from './runtime-host-status'
import type { RuntimeStatus } from './runtime-types'

/**
 * What a host's last probe is worth, kept apart from what the host actually said.
 *
 * The store's `status` field answers both questions with one nullable value, so a probe still in
 * flight, a probe that failed, a host that refused us and a pairing that was retired all arrive at
 * a reader as the same `null`. Readers then spend that `null` on decisions of very different
 * weight. This names the four answers so the decision happens where the evidence is understood.
 *
 * `unverifiable` is never `exited` (docs/reference/ssh-execution-boundary.md). `refused` and
 * `retired` are the only arms carrying positive evidence, and they are separate because they
 * differ in kind: one is the host turning us away, the other is the pairing being ended.
 */
export type RuntimeHostContact =
  | { verdict: 'live'; status: RuntimeStatus }
  | {
      verdict: 'unverifiable'
      reason: RuntimeHostContactUnverifiableReason
      lastAnswer: RuntimeStatus | null
    }
  | { verdict: 'refused'; lastAnswer: RuntimeStatus | null }
  | { verdict: 'retired'; lastAnswer: RuntimeStatus | null }

/**
 * Why the host's current state is unknown. `never-asked` is the absence of any transport attempt,
 * which is where an unreachable paired host permanently sits — distinct from a handshake in
 * flight, and the reason it must stay actionable rather than spin.
 */
export type RuntimeHostContactUnverifiableReason =
  | 'never-asked'
  | 'checking'
  | 'probe-failed'
  | 'transport-connecting'
  | 'transport-down'

/**
 * The host's last answer whatever the verdict, for facts that do not expire — its build's
 * capabilities, its platform, its runtime id. Returns null only when the host never answered.
 */
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

/**
 * Why the order matters: it is the order the connection-state derivation already used, and the
 * parity suite pins every combination against it. Transport loss outranks a probe in flight
 * because a dead socket explains the silence; a ready transport with a failed probe is the host
 * being unreachable at the runtime layer, not at the network layer.
 */
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

/**
 * The contact for a recorded entry. A stored `contact` wins so a writer can state one the
 * snapshot cannot express — a probe that threw before any snapshot existed, say — and the
 * snapshot derivation is the fallback while writers are still being converted.
 */
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
