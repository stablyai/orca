import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import type { AgentJournalRetryLineage } from '../journal/agent-session-journal-dispatch'
import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'

export function structuredAgentSessionRetryLineages(
  submissions: readonly AgentJournalSubmission[]
): Map<string, AgentJournalRetryLineage> {
  const lineages = new Map<string, AgentJournalRetryLineage>()
  if (!submissions.some((send) => send.retryOfClientMessageId || send.retryLineage)) {
    return lineages
  }
  const actual = new Map(submissions.map((send) => [send.clientMessageId, send]))
  const add = (root: string, entry: AgentJournalRetryLineage) => {
    const current = lineages.get(root)
    const order = (send: AgentJournalRetryLineage) =>
      send.dispatchState === 'accepted' ? 2 : send.dispatchState !== 'rejected' ? 1 : 0
    if (
      !current ||
      order(entry) > order(current) ||
      (order(entry) === order(current) && entry.submittedAt >= current.submittedAt)
    ) {
      lineages.set(root, entry)
    }
  }
  for (const send of submissions) {
    if (send.retryOfClientMessageId) {
      add(send.retryOfClientMessageId, send)
    }
  }
  // Bounded reads know the durable ordering when several retries share a timestamp.
  for (const send of submissions) {
    if (send.retryLineage) {
      add(
        send.retryOfClientMessageId ?? send.clientMessageId,
        actual.get(send.retryLineage.clientMessageId) ?? send.retryLineage
      )
    }
  }
  return lineages
}

export function structuredAgentSessionRetryRow(
  root: string,
  retry: AgentJournalRetryLineage,
  hasItem: (id: string) => boolean
): string {
  const rootItem = agentJournalSubmissionKey(root)
  return (retry.dispatchState === 'rejected' || retry.dispatchState === 'pending') &&
    hasItem(rootItem)
    ? rootItem
    : agentJournalSubmissionKey(retry.clientMessageId)
}
