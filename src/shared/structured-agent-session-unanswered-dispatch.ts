import type { AgentJournalSubmission } from './agent-session-journal-types'

/** One send the provider has neither opened a turn for nor refused; the rule is explained on
 *  `hasUnansweredStructuredAgentSessionDispatch`, which asks it of every send. */
export function isUnansweredStructuredAgentSessionDispatch(
  submission: AgentJournalSubmission,
  currentFence?: number | null
): boolean {
  return (
    (currentFence == null || submission.fence >= currentFence) &&
    (submission.dispatchState === 'pending' ||
      (submission.dispatchState === 'unknown' &&
        submission.recovered !== true &&
        // Older hosts publish the recovery reason but omit the optional marker.
        submission.reason !== 'host_restarted_before_acknowledgement'))
  )
}
