// The structured chat's failed and unconfirmed sends, as the notices their transcript bubbles show.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'

const NO_SUBMISSIONS: readonly AgentJournalSubmission[] = []

export function useStructuredAgentSessionDeliveryNotices(args: {
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  retry: (clientMessageId: string) => void
  submissions: readonly AgentJournalSubmission[]
  journalItems: readonly AgentJournalRenderItem[]
  failedHere: ReadonlySet<string>
  agentLabel: string
}): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { agentLabel, failedHere, outbox } = args
  // Read at click time, so the notices stay put while the outbox's Retry is rebuilt each render.
  const retryRef = useRef(args.retry)
  useEffect(() => {
    retryRef.current = args.retry
  })
  const retryDelivery = useCallback((clientMessageId: string) => {
    retryRef.current(clientMessageId)
  }, [])
  // Only a rejected message reads the journal's rows, so a new batch of them re-renders no row else.
  const hasRejected = outbox.some((entry) => entry.state === 'rejected')
  const rejectionRows = hasRejected ? args.submissions : NO_SUBMISSIONS
  const startFailures = useStructuredAgentSessionStartFailureFacts(args.journalItems, hasRejected)
  return useMemo(
    () =>
      structuredAgentSessionDeliveryNotices(
        outbox,
        agentLabel,
        retryDelivery,
        rejectionRows,
        startFailures,
        failedHere
      ),
    [outbox, agentLabel, retryDelivery, rejectionRows, startFailures, failedHere]
  )
}
