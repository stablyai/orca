// Which of the structured chat's own messages say, on their row, that they did not go through, and
// which say quietly that they are still sending: every other one, until the host holds a row that
// has it (pending or accepted). A row in doubt does not, so a message resent over one still reads
// as sending; a rejected row makes it the host's, shown as not sent.
//
// Derived from the outbox on every render and never stored: each failed or held message carries
// its own typed failure, so each row words its own reason. Read through the drain's own rule: while
// the queue is stopped, the message it stopped on and any failed one ahead of it have a Retry, as
// each would go out at once; one behind it would wait unseen. One waiting behind has no failure of
// its own, so it reads as sending; a rejected or refused message holds nothing up, so it keeps its
// words and gets its Retry once the queue moves.
//
// A message the host recorded and then rejected is drawn from the host's history, worded from the
// journal's own fact. It has a Retry only when no agent took it and the host can queue that same
// message again; otherwise sending it again is a new message. A message whose start was refused
// before it ran and that waits for its next try says why and that Orca tries again, whoever sent
// it. A rejection that is a failed start's, the fact a loaded start row from an older host states,
// says only that it was not sent: the row already says why. Until its row loads, the outbox draws
// it from its smaller copy, which leaves on the batch or page that loads the row.

import {
  readAgentSessionFailureFact,
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentSessionWriteNotDoneParts } from '../../../../shared/agent-session-refusal-notice'
import { isStructuredAgentSessionStartFailureRow } from '../../../../shared/structured-agent-session-start-failure-row-key'
import {
  structuredAgentSessionEntryIdExpired,
  structuredAgentSessionEntryRejectedByHost,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  admitStructuredAgentSessionOutboxEntry,
  structuredAgentSessionEntryHeldForRetry
} from '../../../../shared/structured-agent-session-outbox-admission'
import { reconcileStructuredAgentSessionOutboxWithQueue } from '../../../../shared/structured-agent-session-draft-hand-off'
import { structuredAgentSessionEntryResendsUnconfirmed } from '../../../../shared/structured-agent-session-outbox-unconfirmed-resend'
import {
  agentSessionFailureSentence,
  type AgentSessionFailureWordsContext
} from '../../../../shared/agent-session-failure-words'
import { joinSentences } from '../../../../shared/sentence-joining'
import { isRetryingStructuredAgentSessionStart } from '../../../../shared/structured-agent-session-start-retry'
import { isRequeueableAgentJournalSubmission } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import {
  structuredAgentSessionAttemptFailureParts,
  structuredAgentSessionRejectionParts
} from '../../../../shared/structured-agent-session-send-disposition'
import { structuredAgentSessionRejectedShownInPlace } from '../../../../shared/structured-agent-session-message-projection'
import { translate } from '@/i18n/i18n'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

/** One shared value, so a rebuilt map re-renders no row still sending. */
const STRUCTURED_AGENT_SESSION_DELIVERY_SENDING: NativeChatDeliveryNotice = { sending: true }
const NO_COMMANDS: ReadonlySet<string> = new Set()
const NO_ITEMS: readonly AgentJournalRenderItem[] = []
const NO_IDS: ReadonlySet<string> = new Set()

/** A message waiting for its next start: the failure in the reader's language, with no step of the
 *  person's own to try again, then that Orca will. */
function startRetryingNoticeText(submission: AgentJournalSubmission, agentName: string): string {
  const fact = readWholeAgentSessionFailureFact(submission.startRetry?.rejection)
  const reason = fact
    ? agentSessionFailureSentence(
        fact,
        'rejection',
        { agentName, orcaRetries: true },
        sayAgentSessionFailureTranslated
      )
    : (submission.startRetry?.reason ?? '')
  return joinSentences([
    ...(reason ? [reason] : []),
    translate('components.native-chat.startRetrying', 'Orca will try again shortly.')
  ])
}

/** A loaded start-failure row an older host wrote: the failure it states, and when. */
export type StatedStartFailure = {
  itemId: string
  fact: AgentSessionFailureFact
  observedAt: number
}

/** What the chat's loaded start-failure rows state. */
export function structuredAgentSessionStartFailureFacts(
  items: readonly AgentJournalRenderItem[]
): StatedStartFailure[] {
  const stated: StatedStartFailure[] = []
  for (const item of items) {
    if (item.body.kind === 'status' && isStructuredAgentSessionStartFailureRow(item.itemId)) {
      const fact = readAgentSessionFailureFact(item.body.failure)
      if (fact) {
        stated.push({ itemId: item.itemId, fact, observedAt: item.observedAt })
      }
    }
  }
  return stated
}

/** Whether two facts are one failure: a start's row and the messages it rejected share one. */
export function sameAgentSessionFailureFact(
  a: AgentSessionFailureFact,
  b: AgentSessionFailureFact
): boolean {
  return (
    a.kind === b.kind &&
    a.detail?.text === b.detail?.text &&
    a.detail?.audience === b.detail?.audience &&
    a.refusal?.code === b.refusal?.code &&
    a.refusal?.details?.reason === b.refusal?.details?.reason &&
    a.attachment?.reason === b.attachment?.reason &&
    a.attachment?.limit === b.attachment?.limit &&
    a.retry?.error === b.retry?.error &&
    a.retry?.status === b.retry?.status
  )
}

/** Whether one of these start-failure rows already states this failure. Matching is identity, not
 *  wording: what this build can read is enough. */
export function agentSessionFailureStatedByStartRow(
  failure: unknown,
  startFailures: readonly StatedStartFailure[]
): boolean {
  const fact = readAgentSessionFailureFact(failure)
  return (
    fact !== undefined &&
    startFailures.some((stated) => sameAgentSessionFailureFact(stated.fact, fact))
  )
}

/** Whether the row of the start that rejected this message already says why: the same failure,
 *  written after the message was sent and no later than its rejection, as the older host wrote
 *  both. An older row with an equal failure is another start's. */
function rejectionStatedByItsStartRow(
  recorded: AgentJournalSubmission | undefined,
  startFailures: readonly StatedStartFailure[]
): boolean {
  const resolvedAt = recorded?.resolvedAt
  return (
    recorded !== undefined &&
    resolvedAt !== null &&
    resolvedAt !== undefined &&
    agentSessionFailureStatedByStartRow(
      recorded.rejection,
      startFailures.filter(
        ({ observedAt }) => observedAt >= recorded.submittedAt && observedAt <= resolvedAt
      )
    )
  )
}

function deliveryNoticeText(
  entry: StructuredAgentSessionOutboxEntry,
  context: AgentSessionFailureWordsContext,
  failedHere: ReadonlySet<string>
): string {
  // A send attempted before a Stop and then interrupted may already be with the host.
  const attemptedAcrossStop =
    entry.outlivedStop === true && entry.lastAttemptAt !== null && !entry.lastFailure
  if (entry.state === 'unconfirmed' || attemptedAcrossStop) {
    return translate(
      'auto.components.native.chat.NativeChatStructuredSession.1f772bb5d0',
      'Message delivery is unconfirmed.'
    )
  }
  if (!entry.lastFailure) {
    return translate(
      'auto.components.native.chat.NativeChatStructuredSession.93ef441197',
      'Message was not sent.'
    )
  }
  // An earlier attempt under the id the host forgot may already be in the chat.
  if (structuredAgentSessionEntryIdExpired(entry)) {
    return agentSessionWriteNoticeText(['outcomeUnknown'])
  }
  // Its cause may have cleared since it was saved; a Retry it still stops brings the cause back.
  if (structuredAgentSessionEntryHeldForRetry(entry) && !failedHere.has(entry.clientMessageId)) {
    return agentSessionWriteNoticeText(agentSessionWriteNotDoneParts('send'))
  }
  return agentSessionWriteNoticeText(
    structuredAgentSessionAttemptFailureParts(entry.lastFailure, context)
  )
}

function hostRejectionNoticeText(
  submission: AgentJournalSubmission,
  context: AgentSessionFailureWordsContext,
  startFailures: readonly StatedStartFailure[]
): string {
  if (rejectionStatedByItsStartRow(submission, startFailures)) {
    return agentSessionWriteNoticeText(agentSessionWriteNotDoneParts('send'))
  }
  return agentSessionWriteNoticeText(
    structuredAgentSessionRejectionParts(
      submission.reason,
      'send',
      readWholeAgentSessionFailureFact(submission.rejection),
      context
    )
  )
}

/** Keyed by the message id the transcript renders each entry under; `agentName` is the chat's
 *  agent, for the words. */
export function structuredAgentSessionDeliveryNotices(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  agentName: string,
  retry: (clientMessageId: string) => void,
  /** The journal's rows: rejected ones carry more of a rejection than the message keeps, queued
   *  ones may be waiting out a refused start, and a message with no pending or accepted one is
   *  still sending. */
  submissions: readonly AgentJournalSubmission[],
  /** What the loaded start-failure rows state, from `structuredAgentSessionStartFailureFacts`. */
  startFailures: readonly StatedStartFailure[],
  /** Ids whose send failed or was refused while this chat was open: only they word their cause. */
  failedHere: ReadonlySet<string>,
  /** The queue's live cards, which the transcript leaves a rejected message to. */
  queuedMessageIds: readonly string[] = [],
  /** The loaded commands, from `structuredAgentSessionCommandItemIds`: they report their own. */
  commandItemIds: ReadonlySet<string> = NO_COMMANDS,
  /** The loaded rows: a rejected message's outbox copy leaves once its row is here. */
  journalItems: readonly AgentJournalRenderItem[] = NO_ITEMS,
  /** Whether the host queues a message no agent took again under its own id. */
  retriesInPlace = false,
  /** Messages whose Retry waits for the host to say whether it can queue them again. */
  retryWaitsForHost: ReadonlySet<string> = NO_IDS
): ReadonlyMap<string, NativeChatDeliveryNotice> {
  // As the transcript reads it, so a row that lands is answered here before the outbox commits it.
  const entries = reconcileStructuredAgentSessionOutboxWithQueue(outbox, submissions, journalItems)
  const admission = admitStructuredAgentSessionOutboxEntry(entries)
  const held = admission.state === 'blocked' ? admission.entry.clientMessageId : null
  const stalledFrom = admission.state === 'blocked' ? entries.indexOf(admission.entry) : -1
  const rejected = new Map(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => [submission.clientMessageId, submission])
  )
  const notices = new Map<string, NativeChatDeliveryNotice>()
  for (const [index, entry] of entries.entries()) {
    // Resent under its own id until the journal answers, so still sending, not failed.
    if (
      !structuredAgentSessionEntryResendsUnconfirmed(entry, submissions) &&
      (entry.state === 'rejected' ||
        structuredAgentSessionEntryHeldForRetry(entry) ||
        entry.clientMessageId === held)
    ) {
      // Its own Retry is the step, so the words leave out sending again. One the host recorded is
      // the host's: sending it again is a new message, so it has no Retry.
      const retryControl =
        (stalledFrom === -1 || index <= stalledFrom) &&
        !structuredAgentSessionEntryRejectedByHost(entry)
      const text = deliveryNoticeText(entry, { agentName, retryControl }, failedHere)
      notices.set(
        agentJournalSubmissionKey(entry.clientMessageId),
        retryControl ? { text, onRetry: () => retry(entry.clientMessageId) } : { text }
      )
    } else if (
      !submissions.some(
        (submission) =>
          submission.clientMessageId === entry.clientMessageId &&
          (submission.dispatchState === 'pending' || submission.dispatchState === 'accepted')
      )
    ) {
      notices.set(
        agentJournalSubmissionKey(entry.clientMessageId),
        STRUCTURED_AGENT_SESSION_DELIVERY_SENDING
      )
    }
  }
  // After the outbox's: in the host's words, whether its row or the outbox's copy draws it.
  const shown = structuredAgentSessionRejectedShownInPlace(
    submissions,
    queuedMessageIds,
    commandItemIds
  )
  for (const submission of rejected.values()) {
    const { clientMessageId } = submission
    const id = agentJournalSubmissionKey(clientMessageId)
    if (!shown.has(id)) {
      continue
    }
    const waitsForHost = retryWaitsForHost.has(clientMessageId)
    const retryControl =
      isRequeueableAgentJournalSubmission(submission) && (retriesInPlace || waitsForHost)
    const text = hostRejectionNoticeText(submission, { agentName, retryControl }, startFailures)
    notices.set(
      id,
      retryControl
        ? {
            text,
            onRetry: () => retry(clientMessageId),
            ...(waitsForHost ? { retryPending: true as const } : {})
          }
        : { text }
    )
  }
  for (const submission of submissions) {
    if (isRetryingStructuredAgentSessionStart(submission)) {
      notices.set(agentJournalSubmissionKey(submission.clientMessageId), {
        text: startRetryingNoticeText(submission, agentName)
      })
    }
  }
  return notices
}
