// Which of the structured chat's own messages say, on their row, that they did not go through.
//
// Derived from the outbox on every render and never stored: each failed or held message carries
// its own typed failure, so each row words its own reason. Read through the drain's own rule: while
// the queue is stopped, only the message it stopped on has a Retry; another's would wait unseen
// behind it. One waiting behind says nothing; a rejected message holds nothing up, so it keeps its
// words and gets its Retry once the queue moves.
//
// A message the host recorded and then rejected is worded from the journal's own fact, found by id;
// the message keeps only a smaller copy, read when its submission is not loaded. A rejection that
// is a failed start's, the fact its loaded row states, says only that it was not sent: the row
// already says why.

import {
  readAgentSessionFailureFact,
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
  admitStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import type { AgentSessionFailureWordsContext } from '../../../../shared/agent-session-failure-words'
import { structuredAgentSessionAttemptFailureParts } from '../../../../shared/structured-agent-session-send-disposition'
import { translate } from '@/i18n/i18n'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

/** The facts the chat's loaded start-failure rows state. */
export function structuredAgentSessionStartFailureFacts(
  items: readonly AgentJournalRenderItem[]
): AgentSessionFailureFact[] {
  const facts: AgentSessionFailureFact[] = []
  for (const item of items) {
    if (item.body.kind === 'status' && isStructuredAgentSessionStartFailureRow(item.itemId)) {
      const fact = readAgentSessionFailureFact(item.body.failure)
      if (fact) {
        facts.push(fact)
      }
    }
  }
  return facts
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

function deliveryNoticeText(
  entry: StructuredAgentSessionOutboxEntry,
  context: AgentSessionFailureWordsContext,
  recorded: AgentJournalSubmission | undefined,
  startFailures: readonly AgentSessionFailureFact[]
): string {
  if (entry.state === 'unconfirmed') {
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
  const fact = readAgentSessionFailureFact(recorded?.rejection)
  if (
    entry.state === 'rejected' &&
    fact &&
    startFailures.some((stated) => sameAgentSessionFailureFact(stated, fact))
  ) {
    return agentSessionWriteNoticeText(agentSessionWriteNotDoneParts('send'))
  }
  return agentSessionWriteNoticeText(
    structuredAgentSessionAttemptFailureParts(entry.lastFailure, context, fact)
  )
}

/** Keyed by the message id the transcript renders each entry under. `blockedClientMessageId` is
 *  the entry a refusal stopped the queue on; `agentName` is the chat's agent, for the words. */
export function structuredAgentSessionDeliveryNotices(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  blockedClientMessageId: string | null,
  agentName: string,
  retry: (clientMessageId: string) => void,
  /** The journal's rows, whose rejected ones carry more of a rejection than the message keeps. */
  submissions: readonly AgentJournalSubmission[],
  /** What the loaded start-failure rows state, from `structuredAgentSessionStartFailureFacts`. */
  startFailures: readonly AgentSessionFailureFact[]
): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const admission = admitStructuredAgentSessionOutboxEntry(outbox, blockedClientMessageId)
  const held = admission.state === 'blocked' ? admission.entry.clientMessageId : null
  const rejected = new Map(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => [submission.clientMessageId, submission])
  )
  const notices = new Map<string, NativeChatDeliveryNotice>()
  for (const entry of outbox) {
    if (entry.state === 'rejected' || entry.clientMessageId === held) {
      // Its own Retry is the step, so the words leave out sending again.
      const retryControl = held === null || entry.clientMessageId === held
      const text = deliveryNoticeText(
        entry,
        { agentName, retryControl },
        rejected.get(entry.clientMessageId),
        startFailures
      )
      notices.set(
        agentJournalSubmissionKey(entry.clientMessageId),
        retryControl ? { text, onRetry: () => retry(entry.clientMessageId) } : { text }
      )
    }
  }
  return notices
}
