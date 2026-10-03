// Why a submission is `rejected`: the message provably did not happen.
//
// The host writes each rejection twice: `reason`, a sentence (or, for the cases older clients
// already recognise, one of the legacy markers below) that released clients print as it is, and
// `rejection`, the typed fact newer clients read — both from `agentSessionFailureWords`.
// `classifyDispatchRejection` is the only place a reader judges either.
//
// Every rejection makes the one claim that state exists to make: this message did not reach the
// provider. `rejected` is terminal in the reducer, with one exception: the person's Retry of a
// message no agent ever took (`isRequeueableAgentJournalSubmission`) queues that same message again
// under its own id, through its own operation. Any other retry rotates the client message id, which
// is a new message and cannot duplicate.

import {
  isSubmissionRejectionKind,
  readAgentSessionFailureFact,
  type SubmissionRejectionKind
} from './agent-session-failure'
import type { AgentJournalSubmission } from './agent-session-journal-types'

/** Orca could not hand the message over. Written bare: released clients hide it, and the error
 *  that once followed it belongs in the log. Rows from older hosts carry `: <error>` after it. */
export const DISPATCH_REJECTED_WRITE_FAILED = 'provider_write_failed'

/** Local admission refused the frame before any transport was involved. Two
 *  strings rather than one provider-neutral marker because both are already
 *  durable journal reasons; rewording either would relabel rows on disk. */
export const DISPATCH_REJECTED_QUEUE_FULL = 'claude structured dispatch queue is full'
export const DISPATCH_REJECTED_CODEX_QUEUE_FULL = 'codex structured dispatch queue is full'

/** The provider confirmed a queued frame was withdrawn before execution. */
export const DISPATCH_REJECTED_CANCELLED = 'provider_cancelled_before_start'

/** Legacy marker: accepted by a host process that ended before handing it to any provider.
 *  Read only; released clients print it raw, so new rows carry a sentence. */
export const DISPATCH_REJECTED_HOST_RESTARTED = 'host_restarted_before_delivery'

/** Legacy marker: accepted, then the provider was closed before the message was handed to it.
 *  Read only, like the one above. */
export const DISPATCH_REJECTED_PROVIDER_CLOSED = 'provider_closed_before_delivery'

/** Restart reconciliation found the send absent from a provider history it could trust. Rows
 *  written before rows carried a fact hold it as their reason; released clients printed it. */
export const DISPATCH_REJECTED_NOT_DELIVERED = 'not_delivered'

/** True for the internal transport marker, false for a provider's own words. Legacy-reason half
 *  of `isWriteFailureSubmission`; readers go through that or the classifier. */
function dispatchRejectionWasTransportWriteFailure(reason: string | null | undefined): boolean {
  return (
    reason === DISPATCH_REJECTED_WRITE_FAILED ||
    reason?.startsWith(`${DISPATCH_REJECTED_WRITE_FAILED}: `) === true
  )
}

/**
 * What a rejection means for the chat, whatever wrote it:
 * - `withdrawn`: the user's Stop took it back; nothing failed.
 * - `undelivered`: accepted, then never handed over (Orca restarted, the chat closed, the provider
 *   never took it or stopped first).
 * - `startFailed`: the agent it waited on did not start.
 * - `content`: the provider, or Orca's check of the message, refused this payload.
 * - `transport`: Orca could not hand it over.
 */
export type DispatchRejectionCategory =
  | 'withdrawn'
  | 'undelivered'
  | 'startFailed'
  | 'content'
  | 'transport'

export type DispatchRejectionClassification = {
  category: DispatchRejectionCategory
  /** `failure` when the chat reads Failed; null only when no one failed the user: a withdrawal, a
   *  host restart, a chat close, or a send the provider never received after a restart. */
  verdict: 'failure' | null
  /** The situation, when the row carried one or a legacy marker names it; absent for a legacy
   *  sentence, whose words are all a reader has, and for a fact this build cannot place. */
  kind?: SubmissionRejectionKind
}

const KIND_CATEGORY = {
  cancelled: 'withdrawn',
  hostRestarted: 'undelivered',
  chatClosed: 'undelivered',
  notDelivered: 'undelivered',
  providerExited: 'undelivered',
  hostStopped: 'undelivered',
  providerStartFailed: 'startFailed',
  startFailed: 'startFailed',
  notSignedIn: 'startFailed',
  providerMissing: 'startFailed',
  historyTooLarge: 'startFailed',
  managedAccountEnvOverride: 'startFailed',
  accountSwitchInProgress: 'startFailed',
  managedAccountUnsupported: 'startFailed',
  restartFailed: 'startFailed',
  providerRejected: 'content',
  attachmentInvalid: 'content',
  attachmentUnreadable: 'content',
  emptyMessage: 'content',
  commandRefused: 'content',
  queueFull: 'transport',
  writeFailed: 'transport',
  hostFault: 'transport'
} satisfies Record<SubmissionRejectionKind, DispatchRejectionCategory>

/** Null only where no one failed the user; a new kind does not compile until it is placed here. */
const KIND_VERDICT = {
  cancelled: null,
  hostRestarted: null,
  chatClosed: null,
  notDelivered: null,
  providerExited: 'failure',
  providerStartFailed: 'failure',
  startFailed: 'failure',
  notSignedIn: 'failure',
  providerMissing: 'failure',
  historyTooLarge: 'failure',
  managedAccountEnvOverride: 'failure',
  accountSwitchInProgress: 'failure',
  managedAccountUnsupported: 'failure',
  restartFailed: 'failure',
  providerRejected: 'failure',
  attachmentInvalid: 'failure',
  attachmentUnreadable: 'failure',
  emptyMessage: 'failure',
  commandRefused: 'failure',
  queueFull: 'failure',
  writeFailed: 'failure',
  hostFault: 'failure',
  // Orca stopped a start that hung: the agent failed.
  hostStopped: 'failure'
} satisfies Record<SubmissionRejectionKind, 'failure' | null>

/** The legacy markers, by the kind each stands for. */
const LEGACY_MARKER_KINDS: ReadonlyMap<string, SubmissionRejectionKind> = new Map([
  [DISPATCH_REJECTED_CANCELLED, 'cancelled'],
  [DISPATCH_REJECTED_HOST_RESTARTED, 'hostRestarted'],
  [DISPATCH_REJECTED_PROVIDER_CLOSED, 'chatClosed'],
  [DISPATCH_REJECTED_QUEUE_FULL, 'queueFull'],
  [DISPATCH_REJECTED_CODEX_QUEUE_FULL, 'queueFull'],
  [DISPATCH_REJECTED_NOT_DELIVERED, 'notDelivered']
])

/** The kind a legacy marker stands for; undefined for any other reason, which is a sentence. */
function legacyMarkerKind(reason: string | null): SubmissionRejectionKind | undefined {
  if (dispatchRejectionWasTransportWriteFailure(reason)) {
    return 'writeFailed'
  }
  return reason === null ? undefined : LEGACY_MARKER_KINDS.get(reason)
}

/**
 * The one reader of why a submission was rejected. The typed fact decides when the row carries
 * one; a fact this build cannot place says only that the message was not sent. A row with no
 * fact, from an older host, is read by its legacy marker, and any other reason is a sentence — a
 * provider's, or Orca's before rows were typed — which reads as a content failure.
 */
export function classifyDispatchRejection(
  submission: Pick<AgentJournalSubmission, 'reason'> & { rejection?: unknown }
): DispatchRejectionClassification {
  const { rejection } = submission
  const factKind = readAgentSessionFailureFact(rejection)?.kind
  if (typeof rejection === 'object' && rejection !== null && !isSubmissionRejectionKind(factKind)) {
    // Undelivered, not content: all a fact this build can't place proves is the message didn't happen.
    return { category: 'undelivered', verdict: null }
  }
  const kind = isSubmissionRejectionKind(factKind) ? factKind : legacyMarkerKind(submission.reason)
  if (!kind) {
    return { category: 'content', verdict: 'failure' }
  }
  return { category: KIND_CATEGORY[kind], verdict: KIND_VERDICT[kind], kind }
}

/** Rejected because the agent it waited on never took it: what a failed start writes, whatever
 *  the person may have to do first. Orca stopping a start that hung is one, and so is the agent
 *  ending before it was handed the message. */
export function isFailedStartRejection(
  submission: Pick<AgentJournalSubmission, 'reason'> & { rejection?: unknown }
): boolean {
  const { category, kind } = classifyDispatchRejection(submission)
  return category === 'startFailed' || kind === 'hostStopped' || kind === 'providerExited'
}

/** Structural, so a reader holding only these fields of a submission — a restart continuation's
 *  verdict — asks the same question. */
type FailedBeforeHandoverFields = {
  dispatchState?: string
  reason?: string | null
  handedOverAt?: number
  handoverRecorded?: boolean
  rejection?: unknown
}

/** Rejected on its way to an agent, which never took it: a failed start, or Orca's own fault before
 *  any handover. The one rule for where it is drawn, when its failure is announced, whether another
 *  device shows it, and whether a Retry queues it again. */
export function failedBeforeHandover(submission: FailedBeforeHandoverFields): boolean {
  return (
    submission.dispatchState === 'rejected' &&
    submission.handedOverAt === undefined &&
    submission.handoverRecorded === true &&
    isFailedStartOrHostFault({ reason: submission.reason ?? null, rejection: submission.rejection })
  )
}

function isFailedStartOrHostFault(
  submission: Pick<AgentJournalSubmission, 'reason'> & { rejection?: unknown }
): boolean {
  return (
    isFailedStartRejection(submission) || classifyDispatchRejection(submission).kind === 'hostFault'
  )
}

/** Whether the person's Retry may queue this same message again: `failedBeforeHandover`, and no
 *  queued card's, whose card is its Retry. */
export function isRequeueableAgentJournalSubmission(
  submission: FailedBeforeHandoverFields & Pick<AgentJournalSubmission, 'queuedMessageId'>
): boolean {
  return submission.queuedMessageId === undefined && failedBeforeHandover(submission)
}

/**
 * Whether a queued card holds every card behind it until the person acts: one returned for
 * something about it that only they can resolve — the provider or Orca refused its content or
 * attachments, its command did not run, the queue was full, Orca could not hand it over or faulted.
 * One returned because its agent failed to start holds nothing: each card behind it starts the
 * agent again for itself. Orca's fault is not `failedBeforeHandover` here on purpose: a card is
 * returned for it, and the queue waits on the person.
 */
export function queuedCardHoldsQueue(card: {
  state: string
  returnedReason?: string | null
  returnedRejection?: unknown
}): boolean {
  return (
    card.state === 'returned' &&
    !isFailedStartRejection({
      reason: card.returnedReason ?? null,
      rejection: card.returnedRejection
    })
  )
}

/** A Stop withdrew it before it ran: it will not land, and only its sender can send it again. */
export function dispatchWasWithdrawn(
  submission: Pick<AgentJournalSubmission, 'dispatchState' | 'reason' | 'rejection'> | undefined
): boolean {
  return (
    submission?.dispatchState === 'rejected' &&
    classifyDispatchRejection(submission).category === 'withdrawn'
  )
}

/** A submission that says Orca never handed it over, in any dispatch state: journals written
 *  before this state moved hold it as `unknown` carrying the marker. */
export function isWriteFailureSubmission(
  submission: Pick<AgentJournalSubmission, 'reason' | 'rejection'>
): boolean {
  return (
    readAgentSessionFailureFact(submission.rejection)?.kind === 'writeFailed' ||
    dispatchRejectionWasTransportWriteFailure(submission.reason)
  )
}
