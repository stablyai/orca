import type { AgentJournalSubmissionFields } from '../journal/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../requests/agent-session-queued-message-wire'
import type { StructuredAgentSubmission } from './structured-agent-session-submissions'
import type { StructuredAgentSessionOptimisticMessage } from './structured-agent-session-message-projection'
import { handedOffQueuedMessageIds } from './structured-agent-session-draft-hand-off'
import {
  queuedMessageCardImages,
  queuedMessageCardText,
  queuedMessageSteersIn,
  type QueuedMessageCard
} from './structured-agent-session-queued-cards'

/** Cover the gap between sending a queued draft and the host publishing its card. */
export function sendingQueuedMessageCards(
  pending: readonly StructuredAgentSessionOptimisticMessage[],
  heldIds: readonly string[],
  isWorking: boolean,
  submissions: readonly AgentJournalSubmissionFields[]
): QueuedMessageCard[] {
  if (!isWorking || pending.length === 0) {
    return []
  }
  const recorded = new Set([
    ...heldIds,
    ...handedOffQueuedMessageIds(submissions),
    ...submissions.map((submission) => submission.clientMessageId)
  ])
  return pending
    .filter(
      (entry) =>
        entry.phase !== 'unconfirmed' &&
        entry.delivery === 'queue-if-active' &&
        !recorded.has(entry.clientMessageId)
    )
    .map((entry, index) => ({
      messageId: entry.clientMessageId,
      // After every card the host holds, in send order.
      position: Number.MAX_SAFE_INTEGER - pending.length + index,
      text: queuedMessageCardText(entry.body),
      ...queuedMessageCardImages(entry.body),
      state: 'waiting',
      hold: 'sending'
    }))
}

/** Steers the running turn has yet to take in read as sent messages, as when the host steers at once. */
export function steeringQueuedMessageEchoes(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null | undefined,
  submissions: readonly StructuredAgentSubmission[],
  pending: readonly Pick<StructuredAgentSessionOptimisticMessage, 'clientMessageId' | 'queuedAt'>[],
  session: { agentWorking: boolean; queuePaused: boolean }
): StructuredAgentSessionOptimisticMessage[] {
  const steering = (queuedMessages ?? []).filter((message) =>
    queuedMessageSteersIn(message, session)
  )
  if (steering.length === 0) {
    return []
  }
  const handedOff = handedOffQueuedMessageIds(
    submissions.filter((submission) => submission.dispatchState !== 'rejected')
  )
  const sentAt = new Map(pending.map((entry) => [entry.clientMessageId, entry.queuedAt]))
  return steering
    .filter((message) => !handedOff.has(message.messageId))
    .sort((left, right) => left.position - right.position)
    .map((message) => ({
      clientMessageId: message.messageId,
      body: message.body,
      queuedAt: sentAt.get(message.messageId) ?? null,
      phase: 'recorded'
    }))
}
