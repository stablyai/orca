import { useMemo } from 'react'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import type {
  StructuredAgentSubmission,
  SubmissionReceipts
} from '../../../../../../../shared/agent-session/view/structured-agent-session-submissions'
import type { StructuredAgentSessionReadOwner } from '../read/structured-agent-session-read-owner-contract'
import { createStructuredAgentSendingSource } from '../../../../../../../shared/agent-session/view/use-structured-agent-sending'

const NO_RECEIPTS: SubmissionReceipts = new Map()
const noSubscription = () => () => {}
const NO_PENDING: readonly StructuredAgentSessionOptimisticMessage[] = []
const NO_SUBMISSIONS: readonly StructuredAgentSubmission[] = []

export function useStructuredAgentSendingSource(
  owner: StructuredAgentSessionReadOwner | undefined,
  pending = NO_PENDING,
  submissions = NO_SUBMISSIONS
) {
  return useMemo(() => sendingSource(owner, pending, submissions), [owner, pending, submissions])
}

function sendingSource(
  owner: StructuredAgentSessionReadOwner | undefined,
  pending: readonly StructuredAgentSessionOptimisticMessage[],
  submissions: readonly StructuredAgentSubmission[]
) {
  let shownReceipts = NO_RECEIPTS
  return createStructuredAgentSendingSource(
    {
      subscribe: owner?.subscribeDelivery ?? noSubscription,
      getSnapshot: () => {
        if (owner?.getSnapshot().state.submissions === submissions) {
          shownReceipts = owner.getSubmissionReceipts()
        }
        return shownReceipts
      }
    },
    pending,
    submissions
  )
}
