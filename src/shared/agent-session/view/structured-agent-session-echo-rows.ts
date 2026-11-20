import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING } from '../requests/structured-agent-session-send-evidence'
import type { NativeChatMessage } from '../../native-chat/native-chat-types'
import { nativeChatMessageSenderFields } from '../../native-chat-message-sender-fields'
import type { StructuredAgentSessionOptimisticMessage } from './structured-agent-session-message-projection'

/** Client echoes after the conversation until host rows supersede them under either client or
 *  provider IDs; another agent's waiting mail draws in its delivered shape, marked queued. */
export function structuredAgentSessionEchoRows(
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  journalled: ReadonlySet<string>,
  submissionsByItemId: ReadonlyMap<string, AgentJournalSubmission>
): NativeChatMessage[] {
  return optimistic
    .filter((entry) => {
      const key = agentJournalSubmissionKey(entry.clientMessageId)
      const submission = submissionsByItemId.get(key)
      return (
        !journalled.has(key) &&
        (!submission ||
          submission.dispatchState === 'pending' ||
          submission.reason === STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING)
      )
    })
    .map((entry): NativeChatMessage => {
      const id = agentJournalSubmissionKey(entry.clientMessageId)
      const submission = submissionsByItemId.get(id)
      const hostPending =
        submission?.dispatchState === 'pending' &&
        submission.reason !== STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING
      if (entry.waitingAgentMail) {
        return {
          id,
          role: 'user',
          source: 'transcript',
          timestamp: null,
          blocks: entry.body.blocks,
          ...nativeChatMessageSenderFields(entry.body, 'user'),
          queued: true,
          queuedMessageId: entry.clientMessageId
        }
      }
      return {
        id,
        role: 'user',
        source: 'transcript',
        deliveryState:
          hostPending || entry.phase === 'recorded' || entry.recordedCursor !== undefined
            ? 'pending'
            : 'unknown',
        timestamp: entry.queuedAt,
        blocks: entry.body.blocks,
        ...(entry.afterSequence !== undefined
          ? {
              journalPosition: { sequence: entry.afterSequence + 0.5, index: entry.queuedAt ?? 0 }
            }
          : {}),
        ...(entry.sentWhileStopping ? { sentWhileStopping: true as const } : {})
      }
    })
}
