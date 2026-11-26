import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING } from '../requests/structured-agent-session-send-evidence'
import type { NativeChatMessage } from '../../native-chat/native-chat-types'
import type { StructuredAgentSessionOptimisticMessage } from './structured-agent-session-message-projection'

/** Client echoes after the conversation until host rows supersede them under either client or
 *  provider IDs. */
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

const deliveredAgentMail = new WeakMap<NativeChatMessage, NativeChatMessage>()

/** A delivered agent message keeps the queued id its waiting row had, so its open state carries
 *  over; cached per row so an unchanged row keeps its identity across projections. */
export function deliveredAgentMailRow(
  row: NativeChatMessage,
  queuedMessageId: string
): NativeChatMessage {
  const cached = deliveredAgentMail.get(row)
  if (cached?.queuedMessageId === queuedMessageId) {
    return cached
  }
  const next = { ...row, queuedMessageId }
  deliveredAgentMail.set(row, next)
  return next
}
