import type { AgentJournalSubmission } from './agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'

/** One send the provider has neither opened a turn for nor refused; the rule is explained on
 *  `hasUnansweredStructuredAgentSessionDispatch`, which asks it of every send. */
export function isUnansweredStructuredAgentSessionDispatch(
  submission: AgentJournalSubmission,
  currentFence?: number | null
): boolean {
  if (isQueuedAgentJournalSubmission(submission)) {
    // Accepted and still owed to whichever child the host starts next, whatever the fence.
    return true
  }
  return (
    (currentFence == null || submission.fence >= currentFence) &&
    (submission.dispatchState === 'pending' ||
      (submission.dispatchState === 'unknown' &&
        submission.recovered !== true &&
        // Older hosts publish the recovery reason but omit the optional marker.
        submission.reason !== 'host_restarted_before_acknowledgement'))
  )
}

/**
 * A send the host has journaled that the provider has neither opened a turn for nor refused.
 *
 * Codex declares `turn/started` within ~150ms, but Claude's running row can only be written once
 * the SDK echoes the user message back — a 3.4s median and 18s at p90 on real journals. Waiting
 * on that echo to call a session working leaves the whole gap reading idle in the chat and in
 * every session list, so the send itself is the evidence.
 *
 * A live `unknown` still counts because an ambiguous adapter reply does not prove the provider
 * stopped. A recovered `unknown` does not — it outlived the host generation that sent it, so
 * there is nothing still running to report.
 */
export function hasUnansweredStructuredAgentSessionDispatch(
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null
): boolean {
  return submissions.some((submission) =>
    isUnansweredStructuredAgentSessionDispatch(submission, currentFence)
  )
}
