import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  failedStartsSentElsewhere,
  undeliveredSentElsewhere
} from '../../../../shared/structured-agent-session-failed-start-elsewhere'
import { isRetryingStructuredAgentSessionStart } from '../../../../shared/structured-agent-session-start-retry'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'

const NO_SUBMISSIONS: readonly AgentJournalSubmission[] = []

/** The notice on each of the chat's own messages that did not go through, and their Retry. */
export function useStructuredAgentSessionDeliveryNotices(
  controller: Pick<
    ReturnType<typeof useStructuredAgentSession>,
    'retry' | 'retryWaitsForHost' | 'outbox' | 'submissions' | 'journalItems' | 'failedHere'
  >,
  agentLabel: string
) {
  // Read at click time, so the notices stay put while the Retry is rebuilt each render.
  const retryRef = useRef(controller.retry)
  useEffect(() => {
    retryRef.current = controller.retry
  })
  const retryDelivery = useCallback(
    (clientMessageId: string) => retryRef.current(clientMessageId),
    []
  )
  // Only a rejected message, one waiting out a refused start, or one shown from the journal as unsent
  // reads the journal's rows, so a new batch of them re-renders no row else.
  const hasRejected = controller.outbox.some((entry) => entry.state === 'rejected')
  const rejectionRows =
    hasRejected ||
    controller.submissions.some(isRetryingStructuredAgentSessionStart) ||
    failedStartsSentElsewhere(controller.submissions, controller.outbox).length > 0 ||
    undeliveredSentElsewhere(controller.submissions, controller.outbox).length > 0
      ? controller.submissions
      : NO_SUBMISSIONS
  const startFailures = useStructuredAgentSessionStartFailureFacts(
    controller.journalItems,
    hasRejected
  )
  return useMemo(
    () =>
      structuredAgentSessionDeliveryNotices(
        controller.outbox,
        agentLabel,
        retryDelivery,
        rejectionRows,
        startFailures,
        controller.failedHere,
        controller.retryWaitsForHost
      ),
    [
      controller.outbox,
      agentLabel,
      retryDelivery,
      rejectionRows,
      startFailures,
      controller.failedHere,
      controller.retryWaitsForHost
    ]
  )
}
