import { useMemo } from 'react'
import type { AgentJournalSubmission } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import {
  pendingSendsOutsideQueuedCards,
  steeringQueuedMessageEchoes
} from '../../../queue/structured-agent-session-sending-queued-cards'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import { waitingAgentMailEchoes } from '../../../../../../../shared/agent-session/view/structured-agent-session-queued-cards'

/** The sends the transcript draws before the host records them: queued ones stay in their cards,
 *  and other agents' waiting mail follows them in queue order. */
export function useStructuredAgentSessionTranscriptPending(
  chat: {
    queuedMessages: readonly AgentSessionQueuedMessage[] | null
    queuePause: unknown
    submissions: readonly AgentJournalSubmission[]
  },
  pending: readonly StructuredAgentSessionPendingSend[],
  isWorking: boolean
): readonly StructuredAgentSessionOptimisticMessage[] {
  const { queuedMessages, submissions } = chat
  const queuePaused = chat.queuePause !== null
  return useMemo(() => {
    const queuedIds = (queuedMessages ?? []).map((message) => message.messageId)
    const outside = pendingSendsOutsideQueuedCards(pending, queuedIds, isWorking)
    const steering = steeringQueuedMessageEchoes(queuedMessages, submissions, pending, {
      agentWorking: isWorking,
      queuePaused
    })
    const agentMail = waitingAgentMailEchoes(queuedMessages, submissions)
    return steering.length > 0 || agentMail.length > 0
      ? [...outside, ...steering, ...agentMail]
      : outside
  }, [isWorking, pending, queuePaused, queuedMessages, submissions])
}
