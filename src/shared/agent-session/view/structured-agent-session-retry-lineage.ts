import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_DISPATCH_STATES,
  type AgentJournalRetryLineage
} from '../journal/agent-session-journal-dispatch'
import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'
import { agentJournalSubmissionReturnedToCard } from '../requests/agent-session-queued-submission'

export function structuredAgentSessionRetryLineages(
  submissions: readonly AgentJournalSubmission[]
): Map<string, AgentJournalRetryLineage> {
  const lineages = new Map<string, AgentJournalRetryLineage>()
  const attempts: { byId?: Map<string, { root: string; entry: AgentJournalRetryLineage }> } = {}
  const observe = (root: string, entry: AgentJournalRetryLineage) => {
    const previous = attempts.byId?.get(entry.clientMessageId)?.entry
    if (
      AGENT_JOURNAL_DISPATCH_STATES.includes(entry.dispatchState) &&
      (!previous || isFresherRetry(entry, previous))
    ) {
      ;(attempts.byId ??= new Map()).set(entry.clientMessageId, { root, entry })
    }
  }
  for (const send of submissions) {
    const root = send.retryOfClientMessageId
    if (root) {
      observe(root, send)
    }
    if (send.retryLineage) {
      observe(root ?? send.clientMessageId, send.retryLineage)
    }
  }
  const order = (send: AgentJournalRetryLineage) =>
    send.dispatchState === 'accepted' ? 2 : send.dispatchState !== 'rejected' ? 1 : 0
  for (const { root, entry } of attempts.byId?.values() ?? []) {
    const current = lineages.get(root)
    const priority = order(entry)
    const previous = current ? order(current) : -1
    if (
      !current ||
      priority > previous ||
      (priority === previous && entry.submittedAt >= current.submittedAt)
    ) {
      lineages.set(root, entry)
    }
  }
  return lineages
}

function isFresherRetry(
  entry: AgentJournalRetryLineage,
  previous: AgentJournalRetryLineage
): boolean {
  const next = entry.resolvedAt
  const prior = previous.resolvedAt
  if (next != null && prior != null && next !== prior) {
    return next > prior
  }
  return entry.dispatchState === 'accepted' || previous.dispatchState === 'pending'
}

export function structuredAgentSessionRetryRow(
  root: string,
  retry: AgentJournalRetryLineage,
  hasItem: (id: string) => boolean,
  original?: AgentJournalSubmission,
  withdrawn = false
): string {
  const rootItem = agentJournalSubmissionKey(root)
  const retryItem = agentJournalSubmissionKey(retry.clientMessageId)
  if (
    (retry.dispatchState === 'rejected' || retry.dispatchState === 'pending') &&
    ((!withdrawn && retry.dispatchState === 'rejected') || !hasItem(retryItem)) &&
    hasItem(rootItem) &&
    (!original || !agentJournalSubmissionReturnedToCard(original))
  ) {
    return rootItem
  }
  return retryItem
}
