import type { StructuredAgentSubmission } from '../../../../../shared/agent-session/view/structured-agent-session-submissions'
import type { AgentSessionQueuedMessage } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { handedOffQueuedMessageIds } from '../../../../../shared/agent-session/view/structured-agent-session-draft-hand-off'
import { queuedMessageSteersIn } from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import type { StructuredAgentSessionPendingSend } from '../session/structured/delivery/structured-agent-session-pending-sends'

/** Steers the running turn has yet to take in read as sent messages, as when the host steers at once. */
export function steeringQueuedMessageEchoes(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null | undefined,
  submissions: readonly StructuredAgentSubmission[],
  pending: readonly Pick<StructuredAgentSessionPendingSend, 'clientMessageId' | 'queuedAt'>[],
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
