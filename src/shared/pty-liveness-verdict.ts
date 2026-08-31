/**
 * The one vocabulary Orca uses to talk about whether a PTY is live.
 *
 * `exited` requires positive evidence of absence from the owning host. Losing
 * contact with that host — an unregistered SSH provider, a dropped relay, an
 * inventory that only enumerates registered providers — is `unverifiable`, never
 * a death certificate and never a successful stop.
 */
export type PtyLivenessVerdict =
  | { status: 'exited' }
  | { status: 'live'; ptyIds: string[] }
  | { status: 'unverifiable'; reason: string }

/**
 * A pane-presence observation resolved from the controller's synchronous
 * per-id `hasPty` answer, for a pane a successful aggregate inventory did not
 * list.
 *
 * `exited` requires a confirmed answer: an observed `false` from the pane's
 * controller, or a controller with no per-id probe at all — there the
 * successful inventory that failed to list the pane stays the authority. A
 * `null` answer means the probe exists but could not be answered (a failed
 * provider lookup, a probe-less provider behind the adapter); that is
 * `unverifiable`, never absence.
 */
export type PtyPresenceObservation =
  | { status: 'live' }
  | { status: 'exited' }
  | { status: 'unverifiable'; reason: string }

/** A presence answer with the doubt arm excluded: the only shape a demotion decision may consume. */
export type ConfirmedPtyPresence = Exclude<PtyPresenceObservation, { status: 'unverifiable' }>

export function resolveUnlistedPtyPresence(
  hasPtyAnswer: boolean | null | undefined,
  unverifiableReason: string
): PtyPresenceObservation {
  if (hasPtyAnswer === true) {
    return { status: 'live' }
  }
  if (hasPtyAnswer === null) {
    return { status: 'unverifiable', reason: unverifiableReason }
  }
  return { status: 'exited' }
}

/** Typed demotion gate: `unverifiable` is not assignable here, so doubt cannot demote. */
export function isConfirmedPtyAbsence(presence: ConfirmedPtyPresence): boolean {
  return presence.status === 'exited'
}

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
