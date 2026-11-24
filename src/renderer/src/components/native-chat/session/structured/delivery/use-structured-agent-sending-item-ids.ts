import { useMemo, useSyncExternalStore } from 'react'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { structuredAgentSessionSendingItemIds } from '../../../../../../../shared/agent-session/view/structured-agent-session-sending'
import type {
  StructuredAgentSubmission,
  SubmissionReceipts
} from '../../../../../../../shared/agent-session/view/structured-agent-session-submissions'
import type { StructuredAgentSessionReadOwner } from '../read/structured-agent-session-read-owner-contract'

const NO_RECEIPTS: SubmissionReceipts = new Map()
const noReceipts = () => NO_RECEIPTS
const noSubscription = () => () => {}
const NO_PENDING: readonly StructuredAgentSessionOptimisticMessage[] = []
const NO_SUBMISSIONS: readonly StructuredAgentSubmission[] = []

export function useStructuredAgentSendingItemIds(
  owner:
    | Pick<StructuredAgentSessionReadOwner, 'subscribeDelivery' | 'getSubmissionReceipts'>
    | undefined,
  pending = NO_PENDING,
  submissions = NO_SUBMISSIONS
): ReadonlySet<string> {
  const receipts = useSyncExternalStore(
    owner?.subscribeDelivery ?? noSubscription,
    owner?.getSubmissionReceipts ?? noReceipts
  )
  return useMemo(
    () => structuredAgentSessionSendingItemIds(pending, submissions, receipts),
    [pending, submissions, receipts]
  )
}
