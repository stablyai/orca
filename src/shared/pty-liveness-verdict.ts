/**
 * `live` / `unverifiable` / `exited` for a PTY — the fixed verdict vocabulary of
 * docs/reference/ssh-execution-boundary.md.
 *
 * `exited` requires positive evidence of absence from the owning host. Losing
 * contact with that host — an unregistered SSH provider, a dropped relay, an
 * inventory that only enumerates registered providers — is `unverifiable`, never
 * a death certificate and never a successful stop.
 *
 * What that doc fixes is the three spellings, "whatever the field is named" — not
 * one type and not one discriminant. `PtyProcessInspectionEvidence` spells the
 * same three under `verdict`, answering a different question (does this shell
 * have children) with different payloads, and ships them across the relay wire
 * inside `processEvidence`. Keep the shapes separate: renaming that discriminant
 * reads as malformed evidence on the far side of a version skew, which is worse
 * than the field being absent, and the arms are not interchangeable anyway.
 */
export type PtyLivenessVerdict =
  | { status: 'exited' }
  | { status: 'live'; ptyIds: string[] }
  | { status: 'unverifiable'; reason: string }

export const SSH_PROVIDER_UNREGISTERED_REASON = 'its SSH provider is no longer registered'
export const NO_OBSERVING_PROVIDER_REASON = 'no registered provider can observe its host'
export const SSH_EXIT_UNCONFIRMED_REASON = 'the owning SSH host did not confirm the PTY exit'
export const PTY_LIVE_NOTE = 'The PTY is live.'

/** The one sentence every surface uses to admit a stop was not confirmed. */
export function describeUnconfirmedStop(reason: string): string {
  return `The PTY was not confirmed stopped: ${reason}.`
}

/** Words a close whose PTY teardown was never confirmed, for a stop receipt. */
export function describeUnconfirmedAgentStop(close: {
  ptyStopVerdict?: 'live' | 'unverifiable'
  ptyStopReason?: string
}): string {
  const detail =
    close.ptyStopVerdict === 'live'
      ? 'it is live'
      : (close.ptyStopReason ?? 'the stop outcome could not be verified')
  return `The agent terminal was closed but its process could not be confirmed stopped: ${detail}.`
}
