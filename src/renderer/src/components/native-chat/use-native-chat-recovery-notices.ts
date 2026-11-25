import { useCallback } from 'react'
import { useStructuredAgentSessionDeliveryNotices } from '@/components/native-chat/session/structured/delivery/use-structured-agent-session-delivery-notices'
import { dispatchWasWithdrawn } from '../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { useStructuredAgentSessionStartFailureFacts } from '@/components/native-chat/messages/notices/use-structured-agent-session-start-failure-facts'
import { AGENT_SESSION_SEND_RETRY_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { useStructuredAgentSession } from './session/structured/use-structured-agent-session'

export function useNativeChatRecoveryNotices({
  controller,
  target,
  cards,
  includeAllFailures,
  agentLabel
}: {
  controller: Pick<
    ReturnType<typeof useStructuredAgentSession>,
    'pending' | 'submissions' | 'journalItems' | 'send'
  >
  target: Parameters<typeof useStructuredAgentSessionHostCapabilityState>[0]
  cards: readonly { state: string }[]
  includeAllFailures: boolean
  agentLabel: string
}) {
  const needsFailureFacts =
    cards.some((card) => card.state === 'returned') ||
    controller.submissions.some(
      (submission) => submission.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission)
    )
  const startFailures = useStructuredAgentSessionStartFailureFacts(
    controller.journalItems,
    needsFailureFacts || includeAllFailures
  )
  const retryCapable =
    useStructuredAgentSessionHostCapabilityState(
      target,
      AGENT_SESSION_SEND_RETRY_RUNTIME_CAPABILITY
    ) === 'supported'
  const { send: retrySend, journalItems: retryItems } = controller
  const retryDelivery = useCallback(
    (submission: AgentJournalSubmission, bodyClientMessageId: string) => {
      const body = retryItems.find(
        (item) => item.itemId === agentJournalSubmissionKey(bodyClientMessageId)
      )?.body
      if (body?.kind !== 'message' || body.role !== 'user' || body.from) {
        return
      }
      retrySend('', [], {
        retryOfClientMessageId: submission.clientMessageId,
        retainedBody: {
          kind: 'message',
          role: 'user',
          blocks: body.blocks.filter(
            (block) => block.type === 'text' || block.type === 'image-ref'
          ),
          ...(body.skills ? { skills: body.skills } : {})
        },
        callerKeepsText: true
      })
    },
    [retrySend, retryItems]
  )
  const deliveryNotices = useStructuredAgentSessionDeliveryNotices({
    pending: controller.pending,
    submissions: controller.submissions,
    journalItems: controller.journalItems,
    startFailures,
    agentName: agentLabel,
    ...(retryCapable ? { onRetry: retryDelivery } : {})
  })
  return { deliveryNotices, startFailures }
}
