import { useMemo } from 'react'
import type { AgentJournalSubmission } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { pendingSendsOutsideQueuedCards } from '../../../../../../../shared/agent-session/view/structured-agent-session-sending'
import { steeringQueuedMessageEchoes } from '../../../queue/structured-agent-session-sending-queued-cards'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

/** The sends the transcript draws before the host records them: queued ones stay in their cards. */
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
    return steering.length > 0 ? [...outside, ...steering] : outside
  }, [isWorking, pending, queuePaused, queuedMessages, submissions])
}
