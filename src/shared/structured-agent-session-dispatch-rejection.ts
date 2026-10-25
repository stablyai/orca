// Rejected proves non-delivery. The host writes printable legacy reason plus typed rejection via agentSessionFailureWords;
// classifyDispatchRejection owns interpretation. Rejected is terminal: Retry rotates message ID because the old ID never redelivers.

import {
  isSubmissionRejectionKind,
  readAgentSessionFailureFact,
  type SubmissionRejectionKind
} from './agent-session-failure'
import type { AgentJournalSubmission } from './agent-session-journal-types'

/** Bare marker is hidden by released clients; log the error separately. Older hosts append : <error>. */
export const DISPATCH_REJECTED_WRITE_FAILED = 'provider_write_failed'

/** Both provider-specific strings already exist in durable journals; replacing them would relabel saved rows. */
export const DISPATCH_REJECTED_QUEUE_FULL = 'claude structured dispatch queue is full'
export const DISPATCH_REJECTED_CODEX_QUEUE_FULL = 'codex structured dispatch queue is full'

/** The provider confirmed a queued frame was withdrawn before execution. */
export const DISPATCH_REJECTED_CANCELLED = 'provider_cancelled_before_start'

/** Read-only restart marker; new hosts write a sentence because released clients print it raw. */
export const DISPATCH_REJECTED_HOST_RESTARTED = 'host_restarted_before_delivery'

/** Read-only legacy marker: provider closed before handover. */
export const DISPATCH_REJECTED_PROVIDER_CLOSED = 'provider_closed_before_delivery'

/** Read-only legacy restart guess: message absent from provider history. */
export const DISPATCH_REJECTED_NOT_DELIVERED = 'not_delivered'

/** Legacy transport-marker reader; use isWriteFailureSubmission or the classifier, not provider prose. */
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
  /** Failure verdict only when the user was failed; lifecycle withdrawals/restarts may be undelivered without failure. */
  verdict: 'failure' | null
  /** Absent for untyped legacy prose or a typed fact this build cannot interpret. */
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
  cliMissing: 'startFailed',
  historyTooLarge: 'startFailed',
  managedAccountEnvOverride: 'startFailed',
  accountSwitchInProgress: 'startFailed',
  managedAccountUnsupported: 'startFailed',
  launchFolderMissing: 'startFailed',
  historyInOtherAccount: 'startFailed',
  claudeAccountFolderMissing: 'startFailed',
  claudeAccountSetupFailed: 'startFailed',
  agentCommandNotRunnable: 'startFailed',
  runtimeNotInstalled: 'startFailed',
  restartFailed: 'startFailed',
  providerRejected: 'content',
  attachmentInvalid: 'content',
  attachmentUnreadable: 'content',
  emptyMessage: 'content',
  commandUnavailable: 'content',
  commandRefused: 'content',
  queueFull: 'transport',
  writeFailed: 'transport',
  hostFault: 'transport'
} satisfies Record<SubmissionRejectionKind, DispatchRejectionCategory>

/** Exhaustive kind placement; null means no failure verdict. */
const KIND_VERDICT = {
  cancelled: null,
  hostRestarted: null,
  chatClosed: null,
  notDelivered: null,
  providerExited: 'failure',
  providerStartFailed: 'failure',
  startFailed: 'failure',
  notSignedIn: 'failure',
  cliMissing: 'failure',
  historyTooLarge: 'failure',
  managedAccountEnvOverride: 'failure',
  accountSwitchInProgress: 'failure',
  managedAccountUnsupported: 'failure',
  launchFolderMissing: 'failure',
  historyInOtherAccount: 'failure',
  claudeAccountFolderMissing: 'failure',
  claudeAccountSetupFailed: 'failure',
  agentCommandNotRunnable: 'failure',
  runtimeNotInstalled: 'failure',
  restartFailed: 'failure',
  providerRejected: 'failure',
  attachmentInvalid: 'failure',
  attachmentUnreadable: 'failure',
  emptyMessage: 'failure',
  commandUnavailable: 'failure',
  commandRefused: 'failure',
  queueFull: 'failure',
  writeFailed: 'failure',
  hostFault: 'failure',
  // Orca stopped a start that hung: the agent failed.
  hostStopped: 'failure'
} satisfies Record<SubmissionRejectionKind, 'failure' | null>

const LEGACY_MARKER_KINDS: ReadonlyMap<string, SubmissionRejectionKind> = new Map([
  [DISPATCH_REJECTED_CANCELLED, 'cancelled'],
  [DISPATCH_REJECTED_HOST_RESTARTED, 'hostRestarted'],
  [DISPATCH_REJECTED_PROVIDER_CLOSED, 'chatClosed'],
  [DISPATCH_REJECTED_QUEUE_FULL, 'queueFull'],
  [DISPATCH_REJECTED_CODEX_QUEUE_FULL, 'queueFull'],
  [DISPATCH_REJECTED_NOT_DELIVERED, 'notDelivered']
])

function legacyMarkerKind(reason: string | null): SubmissionRejectionKind | undefined {
  if (dispatchRejectionWasTransportWriteFailure(reason)) {
    return 'writeFailed'
  }
  return reason === null ? undefined : LEGACY_MARKER_KINDS.get(reason)
}

/** Typed facts outrank prose; unknown facts prove non-delivery without a failure verdict.
 * Without facts, interpret legacy markers; other older-host/provider sentences remain content failures. */
export function classifyDispatchRejection(
  submission: Pick<AgentJournalSubmission, 'reason'> & { rejection?: unknown }
): DispatchRejectionClassification {
  const { rejection } = submission
  const factKind = readAgentSessionFailureFact(rejection)?.kind
  if (typeof rejection === 'object' && rejection !== null && !isSubmissionRejectionKind(factKind)) {
    // Unknown facts prove non-delivery but cannot establish a content failure.
    return { category: 'undelivered', verdict: null }
  }
  const kind = isSubmissionRejectionKind(factKind) ? factKind : legacyMarkerKind(submission.reason)
  if (!kind) {
    return { category: 'content', verdict: 'failure' }
  }
  return { category: KIND_CATEGORY[kind], verdict: KIND_VERDICT[kind], kind }
}

/** Withdrawn before running; only an explicit user resend may deliver it. */
export function dispatchWasWithdrawn(
  submission: Pick<AgentJournalSubmission, 'dispatchState' | 'reason' | 'rejection'> | undefined
): boolean {
  return (
    submission?.dispatchState === 'rejected' &&
    classifyDispatchRejection(submission).category === 'withdrawn'
  )
}

/** Read write failure even on legacy journals that kept this marker under dispatchState unknown. */
export function isWriteFailureSubmission(
  submission: Pick<AgentJournalSubmission, 'reason' | 'rejection'>
): boolean {
  return (
    readAgentSessionFailureFact(submission.rejection)?.kind === 'writeFailed' ||
    dispatchRejectionWasTransportWriteFailure(submission.reason)
  )
}
