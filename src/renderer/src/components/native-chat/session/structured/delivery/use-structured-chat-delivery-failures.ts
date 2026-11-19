import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import { dispatchWasWithdrawn } from '../../../../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { useStructuredAgentSessionStartFailureFacts } from '../../../messages/notices/use-structured-agent-session-start-failure-facts'
import { useStructuredAgentSessionDeliveryNotices } from './use-structured-agent-session-delivery-notices'

type DeliveryInputs = Parameters<typeof useStructuredAgentSessionDeliveryNotices>[0]

/** A structured chat's start failures and the delivery notices they word. */
export function useStructuredChatDeliveryFailures(
  controller: Pick<DeliveryInputs, 'pending' | 'submissions' | 'journalItems'>,
  queuedCards: readonly { state: string }[],
  agent: AgentType,
  agentName: string
) {
  const needsFailureFacts =
    queuedCards.some((card) => card.state === 'returned') ||
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
    agentName
  })
  return { startFailures, deliveryNotices }
}
