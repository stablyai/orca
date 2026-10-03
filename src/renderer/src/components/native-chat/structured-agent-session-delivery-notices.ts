// Which of the structured chat's own messages say, on their row, that they did not go through.
//
// Derived from the outbox on every render and never stored: each failed or held message carries
// its own typed failure, so each row words its own reason. Read through the drain's own rule: while
// the queue is stopped, the message it stopped on and any failed one ahead of it have a Retry, as
// each would go out at once; one behind it would wait unseen. One waiting behind says nothing; a
// rejected or refused message holds nothing up, so it keeps its words and gets its Retry once the
// queue moves.
//
// A message the host recorded and then rejected is worded from the journal's own fact, found by id;
// the message keeps only a smaller copy, read when its submission is not loaded. A message whose
// start was refused before it ran and that waits for its next try says why and that Orca tries
// again, whoever sent it. A rejection that is a failed start's, the fact a loaded start row from an older host
// states, says only that it was not sent: the row already says why. One rejected after it was
// handed over says why, whoever sent it.

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
  structuredAgentSessionRejectedFailure,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  admitStructuredAgentSessionOutboxEntry,
  structuredAgentSessionEntryHeldForRetry
} from '../../../../shared/structured-agent-session-outbox-admission'
import {
  agentSessionFailureSentence,
  type AgentSessionFailureWordsContext
} from '../../../../shared/agent-session-failure-words'
import { joinSentences } from '../../../../shared/sentence-joining'
import { isRetryingStructuredAgentSessionStart } from '../../../../shared/structured-agent-session-start-retry'
import {
  failedStartsSentElsewhere,
  undeliveredSentElsewhere
} from '../../../../shared/structured-agent-session-failed-start-elsewhere'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { structuredAgentSessionAttemptFailureParts } from '../../../../shared/structured-agent-session-send-disposition'
import { translate } from '@/i18n/i18n'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

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
  recorded: AgentJournalSubmission | undefined,
  startFailures: readonly StatedStartFailure[],
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
  if (entry.state === 'rejected' && rejectionStatedByItsStartRow(recorded, startFailures)) {
    return agentSessionWriteNoticeText(agentSessionWriteNotDoneParts('send'))
  }
  return agentSessionWriteNoticeText(
    structuredAgentSessionAttemptFailureParts(
      entry.lastFailure,
      context,
      readWholeAgentSessionFailureFact(recorded?.rejection)
    )
  )
}

/** Keyed by the message id the transcript renders each entry under; `agentName` is the chat's
 *  agent, for the words. */
export function structuredAgentSessionDeliveryNotices(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  agentName: string,
  retry: (clientMessageId: string) => void,
  /** The journal's rows, whose rejected ones carry more of a rejection than the message keeps, and
   *  whose queued ones may be waiting out a refused start. */
  submissions: readonly AgentJournalSubmission[],
  /** What the loaded start-failure rows state, from `structuredAgentSessionStartFailureFacts`. */
  startFailures: readonly StatedStartFailure[],
  /** Ids whose send failed or was refused while this chat was open: only they word their cause. */
  failedHere: ReadonlySet<string>,
  /** Messages whose Retry waits for the host to say whether it can queue them again. */
  retryWaitsForHost: ReadonlySet<string> = new Set()
): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const retryControlFor = (
    clientMessageId: string
  ): Pick<NativeChatDeliveryNotice, 'onRetry' | 'retryPending'> => ({
    onRetry: () => retry(clientMessageId),
    ...(retryWaitsForHost.has(clientMessageId) ? { retryPending: true as const } : {})
  })
  const admission = admitStructuredAgentSessionOutboxEntry(outbox)
  const held = admission.state === 'blocked' ? admission.entry.clientMessageId : null
  const stalledFrom = admission.state === 'blocked' ? outbox.indexOf(admission.entry) : -1
  const rejected = new Map(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => [submission.clientMessageId, submission])
  )
  const notices = new Map<string, NativeChatDeliveryNotice>()
  for (const [index, entry] of outbox.entries()) {
    if (
      entry.state === 'rejected' ||
      structuredAgentSessionEntryHeldForRetry(entry) ||
      entry.clientMessageId === held
    ) {
      // Its own Retry is the step, so the words leave out sending again.
      const retryControl = stalledFrom === -1 || index <= stalledFrom
      const text = deliveryNoticeText(
        entry,
        { agentName, retryControl },
        rejected.get(entry.clientMessageId),
        startFailures,
        failedHere
      )
      notices.set(
        agentJournalSubmissionKey(entry.clientMessageId),
        retryControl ? { text, ...retryControlFor(entry.clientMessageId) } : { text }
      )
    }
  }
  for (const submission of submissions) {
    if (isRetryingStructuredAgentSessionStart(submission)) {
      notices.set(agentJournalSubmissionKey(submission.clientMessageId), {
        text: startRetryingNoticeText(submission, agentName)
      })
    }
  }
  // Drawn only where the host can queue it again in place, so each has its Retry.
  for (const submission of failedStartsSentElsewhere(submissions, outbox)) {
    const { clientMessageId } = submission
    const fact = readWholeAgentSessionFailureFact(submission.rejection)
    const text = fact
      ? agentSessionFailureSentence(
          fact,
          'rejection',
          { agentName, retryControl: true },
          sayAgentSessionFailureTranslated
        )
      : (submission.reason ?? '')
    notices.set(agentJournalSubmissionKey(clientMessageId), {
      text,
      ...retryControlFor(clientMessageId)
    })
  }
  // Worded as this client's own copy would be, with no Retry: the host cannot queue it again.
  for (const submission of undeliveredSentElsewhere(submissions, outbox)) {
    notices.set(agentJournalSubmissionKey(submission.clientMessageId), {
      text: agentSessionWriteNoticeText(
        structuredAgentSessionAttemptFailureParts(
          structuredAgentSessionRejectedFailure(submission),
          { agentName, retryControl: false },
          readWholeAgentSessionFailureFact(submission.rejection)
        )
      )
    })
  }
  return notices
}
