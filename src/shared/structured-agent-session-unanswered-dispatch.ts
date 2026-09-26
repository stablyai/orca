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
