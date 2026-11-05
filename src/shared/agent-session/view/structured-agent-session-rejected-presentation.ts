import { finishAgentSessionSteps } from '../agent-session-projection-steps'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { agentSessionContextSequenceFor } from '../agent-session-context-clear'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { dispatchWasWithdrawn } from '../requests/structured-agent-session-dispatch-rejection'
export function structuredAgentSessionCommandItemIds(
  items: readonly AgentJournalRenderItem[]
): Set<string> {
  return finishAgentSessionSteps(commandItemIdSteps(items))
}
export function* commandItemIdSteps(
  items: readonly AgentJournalRenderItem[]
): Generator<void, Set<string>> {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.body.kind === 'message' && item.body.command) {
      ids.add(item.itemId)
    }
    yield
  }
  return ids
}

/** Rejected sends shown as unsent in submission order; withdrawals use stop notices, queued handoffs/cards keep their cards,
 * and commands carry rejection in their own reply. */
export function structuredAgentSessionRejectedShownInPlace(
  submissions: readonly AgentJournalSubmission[],
  commandItemIds: ReadonlySet<string>,
  clearSequences: readonly number[] = []
): Set<string> {
  return finishAgentSessionSteps(
    rejectedShownInPlaceSteps(submissions, commandItemIds, clearSequences)
  )
}
export function* rejectedShownInPlaceSteps(
  submissions: readonly AgentJournalSubmission[],
  commandItemIds: ReadonlySet<string>,
  clearSequences: readonly number[] = []
): Generator<void, Set<string>> {
  const latest = new Map<string, number>()
  const later: (number | undefined)[] = []
  const scopeKey = (submission: AgentJournalSubmission) =>
    JSON.stringify([
      agentSessionContextSequenceFor(submission.acceptedSequence ?? 0, clearSequences),
      submission.payloadFingerprint
    ])
  for (let index = submissions.length - 1; index >= 0; index--) {
    yield
    const submission = submissions[index]
    const key = scopeKey(submission)
    later[index] = latest.get(key)
    if (!dispatchWasWithdrawn(submission)) {
      latest.set(key, Math.max(latest.get(key) ?? -Infinity, submission.submittedAt))
    }
  }
  const shown = new Set<string>()
  for (const [index, submission] of submissions.entries()) {
    yield
    const { resolvedAt } = submission
    if (
      submission.dispatchState !== 'rejected' ||
      dispatchWasWithdrawn(submission) ||
      submission.queuedMessageId !== undefined ||
      // Persist card ownership on the send so editing/deleting the card cannot resurrect its row.
      submission.keptAsQueuedMessageId !== undefined ||
      commandItemIds.has(agentJournalSubmissionKey(submission.clientMessageId)) ||
      // Collapses resends of a rejected message: past Retries resent it under a new id, and the
      // host re-delivers its own messages under new ids. Only a later copy sent once the rejection
      // was known counts, so a repeat sent before it is kept.
      (resolvedAt !== null && later[index] !== undefined && later[index] >= resolvedAt)
    ) {
      continue
    }
    shown.add(agentJournalSubmissionKey(submission.clientMessageId))
  }
  return shown
}
