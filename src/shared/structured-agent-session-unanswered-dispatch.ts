import type { AgentJournalSubmission } from './agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'

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

/** Use the send as Working evidence before a provider opens its turn: real Claude echoes took 3.4s median/18s p90,
 * or never arrived during rate-limit retries, versus ~150ms Codex starts. Live unknown remains owed; recovered unknown outlived its sending generation. */
export function hasUnansweredStructuredAgentSessionDispatch(
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null
): boolean {
  return submissions.some((submission) =>
    isUnansweredStructuredAgentSessionDispatch(submission, currentFence)
  )
}
