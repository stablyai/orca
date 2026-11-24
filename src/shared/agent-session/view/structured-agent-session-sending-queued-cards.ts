import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'
import type { StructuredAgentSessionOptimisticMessage } from './structured-agent-session-message-projection'
import { handedOffQueuedMessageIds } from './structured-agent-session-draft-hand-off'
import {
  queuedMessageCardImages,
  queuedMessageCardText,
  type QueuedMessageCard
} from './structured-agent-session-queued-cards'

/** Cover the gap between sending a queued draft and the host publishing its card. */
export function sendingQueuedMessageCards(
  pending: readonly StructuredAgentSessionOptimisticMessage[],
  heldIds: readonly string[],
  isWorking: boolean,
  submissions: readonly AgentJournalSubmission[]
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
