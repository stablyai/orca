import type { useStructuredAgentSession } from '@/components/native-chat/session/structured/use-structured-agent-session'
import type { useStructuredNativeChatSubmitReveal } from '@/components/native-chat/pane/actions/use-structured-native-chat-submit-reveal'
import { useStructuredAgentSessionDeliveryNotices } from '@/components/native-chat/session/structured/delivery/use-structured-agent-session-delivery-notices'
import { dispatchWasWithdrawn } from '../../../../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { useStructuredAgentSessionStartFailureFacts } from '@/components/native-chat/messages/notices/use-structured-agent-session-start-failure-facts'

/** Start-failure facts (read only when a returned or rejected send, or Claude, needs them) and the delivery notices built on them. */
export function useStructuredChatFailureNotices(
  agent: string,
  agentLabel: string,
  controller: ReturnType<typeof useStructuredAgentSession>,
  submits: ReturnType<typeof useStructuredNativeChatSubmitReveal>
) {
  const needsFailureFacts =
    submits.queuedMessages.cards.some((card) => card.state === 'returned') ||
    controller.submissions.some(
      (submission) => submission.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission)
    )
  const startFailures = useStructuredAgentSessionStartFailureFacts(
    controller.journalItems,
    needsFailureFacts || agent === 'claude'
  )
  const deliveryNotices = useStructuredAgentSessionDeliveryNotices({
    pending: controller.pending,
    submissions: controller.submissions,
    journalItems: controller.journalItems,
    startFailures,
    agentName: agentLabel
  })
  return { startFailures, deliveryNotices }
}
