import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { dispatchWasWithdrawn } from '../requests/structured-agent-session-dispatch-rejection'
import { readAgentSessionFailureFact } from '../failures/agent-session-failure'
import { agentSessionContextSequenceFor } from '../conversation-context/agent-session-context-clear'
import { agentJournalSubmissionReturnedToCard } from '../requests/agent-session-queued-submission'
import { structuredAgentSessionRetryLineages } from './structured-agent-session-retry-lineage'

/** Rejected sends shown as unsent in submission order; withdrawals use stop notices, queued handoffs/cards keep their cards,
 * and commands carry rejection in their own reply. `resent`: rejected sends a later copy stands in for. */
export function structuredAgentSessionRejectedShownInPlace(
  submissions: readonly AgentJournalSubmission[],
  commandItemIds: ReadonlySet<string>,
  clearSequences: readonly number[] = []
): { shown: Set<string>; resent: Set<string> } {
  const latest = new Map<string, number>()
  const lineages = structuredAgentSessionRetryLineages(submissions)
  const later = Array.from<number | undefined>({ length: submissions.length })
  const scopeKey = (submission: AgentJournalSubmission) =>
    JSON.stringify([
      agentSessionContextSequenceFor(submission.acceptedSequence ?? 0, clearSequences),
      submission.payloadFingerprint
    ])
  for (let index = submissions.length - 1; index >= 0; index--) {
    const submission = submissions[index]
    const key = scopeKey(submission)
    later[index] = latest.get(key)
    if (!dispatchWasWithdrawn(submission)) {
      latest.set(key, Math.max(latest.get(key) ?? -Infinity, submission.submittedAt))
    }
  }
  const shown = new Set<string>()
  const resent = new Set<string>()
  for (const [index, submission] of submissions.entries()) {
    const { resolvedAt } = submission
    if (
      submission.dispatchState !== 'rejected' ||
      dispatchWasWithdrawn(submission) ||
      // Persist card ownership on the send so editing/deleting the card cannot resurrect its row.
      agentJournalSubmissionReturnedToCard(submission) ||
      commandItemIds.has(agentJournalSubmissionKey(submission.clientMessageId))
    ) {
      continue
    }
    // Collapses resends of a rejected message: past Retries resent it under a new id, and the
    // host re-delivers its own messages under new ids. Only a later copy sent once the rejection
    // was known counts, so a repeat sent before it is kept.
    const key = agentJournalSubmissionKey(submission.clientMessageId)
    if (
      lineages.get(submission.retryOfClientMessageId ?? submission.clientMessageId)
        ?.dispatchState === 'accepted' ||
      (!readAgentSessionFailureFact(submission.rejection)?.instructionRecovery &&
        resolvedAt !== null &&
        later[index] !== undefined &&
        later[index] >= resolvedAt)
    ) {
      resent.add(key)
    } else {
      shown.add(key)
    }
  }
  return { shown, resent }
}
