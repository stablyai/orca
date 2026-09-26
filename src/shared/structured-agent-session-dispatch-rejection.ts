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

import type { AgentSessionFailureFact } from './agent-session-failure'

export const DISPATCH_REJECTED_WRITE_FAILED = 'provider_write_failed'

/** Local admission refused the frame before any transport was involved. Two
 *  strings rather than one provider-neutral marker because both are already
 *  durable journal reasons; rewording either would relabel rows on disk. */
export const DISPATCH_REJECTED_QUEUE_FULL = 'claude structured dispatch queue is full'
export const DISPATCH_REJECTED_CODEX_QUEUE_FULL = 'codex structured dispatch queue is full'

/** The provider confirmed a queued frame was withdrawn before execution. */
export const DISPATCH_REJECTED_CANCELLED = 'provider_cancelled_before_start'

/** Accepted by a host process that ended before handing it to any provider. */
export const DISPATCH_REJECTED_HOST_RESTARTED = 'host_restarted_before_delivery'

/** Accepted, then the provider was closed before the message was handed to it. */
export const DISPATCH_REJECTED_PROVIDER_CLOSED = 'provider_closed_before_delivery'

export function dispatchWriteFailureReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${DISPATCH_REJECTED_WRITE_FAILED}: ${detail}`
}

/** A rejection as the host writes it: the sentence (or legacy marker) released clients print, and
 *  the typed fact newer ones read. */
export type AgentJournalDispatchRejection = {
  reason: string
  rejection: AgentSessionFailureFact
}

export const DISPATCH_REJECTION_CANCELLED: AgentJournalDispatchRejection = {
  reason: DISPATCH_REJECTED_CANCELLED,
  rejection: { kind: 'cancelled' }
}

export const DISPATCH_REJECTION_HOST_RESTARTED: AgentJournalDispatchRejection = {
  reason: DISPATCH_REJECTED_HOST_RESTARTED,
  rejection: { kind: 'hostRestarted' }
}

export const DISPATCH_REJECTION_PROVIDER_CLOSED: AgentJournalDispatchRejection = {
  reason: DISPATCH_REJECTED_PROVIDER_CLOSED,
  rejection: { kind: 'chatClosed' }
}

/** The marker keeps its Orca text after the prefix, as released clients expect; they hide it. */
export function dispatchWriteFailureRejection(error: unknown): AgentJournalDispatchRejection {
  return { reason: dispatchWriteFailureReason(error), rejection: { kind: 'writeFailed' } }
}

export function dispatchQueueFullRejection(
  marker: typeof DISPATCH_REJECTED_QUEUE_FULL | typeof DISPATCH_REJECTED_CODEX_QUEUE_FULL
): AgentJournalDispatchRejection {
  return { reason: marker, rejection: { kind: 'queueFull' } }
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

/**
 * True when the reason is ours rather than the provider's, so it must not be
 * shown verbatim. A content rejection carries the provider's own explanation and
 * is the only kind a person should read.
 */
export function dispatchRejectionReasonIsInternal(reason: string | null | undefined): boolean {
  return (
    dispatchRejectionWasTransportWriteFailure(reason) ||
    reason === DISPATCH_REJECTED_QUEUE_FULL ||
    reason === DISPATCH_REJECTED_CODEX_QUEUE_FULL ||
    reason === DISPATCH_REJECTED_CANCELLED ||
    reason === DISPATCH_REJECTED_HOST_RESTARTED ||
    reason === DISPATCH_REJECTED_PROVIDER_CLOSED
  )
}
