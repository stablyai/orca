import { isClaudeSignInFailureKind } from './native-chat-claude-sign-in'
import { useStructuredAgentSessionDeliveryNotices } from './use-structured-agent-session-delivery-notices'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'

export function useStructuredNativeChatDelivery(
  args: Omit<Parameters<typeof useStructuredAgentSessionDeliveryNotices>[0], 'startFailures'> & {
    agent: string
    hasReturnedMessages: boolean
  }
) {
  const needsFailureFacts =
    args.hasReturnedMessages ||
    args.submissions.some(
      (submission) => submission.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission)
    )
  const startFailures = useStructuredAgentSessionStartFailureFacts(
    args.journalItems,
    needsFailureFacts || args.agent === 'claude'
  )
  const deliveryNotices = useStructuredAgentSessionDeliveryNotices({
    pending: args.pending,
    submissions: args.submissions,
    journalItems: args.journalItems,
    startFailures,
    agentName: args.agentName
  })
  const signInFailureRows = startFailures.filter((fact) =>
    isClaudeSignInFailureKind(fact.kind)
  ).length
  return { startFailures, deliveryNotices, signInFailureRows }
}
