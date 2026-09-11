// Why a submission is `rejected`: the message provably did not happen.
//
// Two different facts reach this state, and the reason string is what tells them
// apart. A CONTENT rejection is permanent — the provider looked at this payload
// and refused it, and it would refuse the same payload again; its reason is the
// provider's own explanation ("Claude messages support at most 20 images") and is
// meant to be read. A TRANSPORT rejection is transient — the frame was never
// handed to the provider at all, so the same text under a fresh id is a first
// delivery and the next attempt may well succeed; its reason names an internal
// cause and must NOT be put in front of a person.
//
// Both are `rejected` because both make the single claim that state exists to
// make: this message did not reach the provider. Neither is ever re-delivered
// under its own id — `rejected` is terminal in the reducer — so a retry rotates
// the client message id, which is a new message and cannot duplicate.
//
// Shared rather than main-only because both sides need it: the host writes the
// reason, and a client has to know which kind it is holding before it can decide
// whether the string is showable.

export const DISPATCH_REJECTED_WRITE_FAILED = 'provider_write_failed'

export function dispatchWriteFailureReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${DISPATCH_REJECTED_WRITE_FAILED}: ${detail}`
}

/** True for the internal transport marker, false for a provider's own words. */
export function dispatchRejectionWasTransportWriteFailure(
  reason: string | null | undefined
): boolean {
  return (
    reason === DISPATCH_REJECTED_WRITE_FAILED ||
    reason?.startsWith(`${DISPATCH_REJECTED_WRITE_FAILED}: `) === true
  )
}
