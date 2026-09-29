import type { AgentJournalSubmission } from './agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { structuredAgentSessionSubmissionSettlement } from './structured-agent-session-submission-settlement'

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
    structuredAgentSessionSubmissionSettlement(submission) === 'open'
  )
}

/**
 * A send the host has journaled that the provider has neither opened a turn for nor refused.
 *
 * Codex declares `turn/started` within ~150ms, but Claude's running row can only be written once
 * the SDK echoes the user message back — a 3.4s median and 18s at p90 on real journals, and no
 * echo at all while it retries a rate-limited request. Waiting on that echo to call a session
 * working leaves the whole gap reading idle in the chat and in every session list, so the send
 * itself is the evidence.
 *
 * A live `unknown` (only an older host writes one) still counts: an ambiguous adapter reply does
 * not prove the provider stopped. A recovered `unknown` does not — the provider's turn end, a
 * Stop, a start that threw or the end of the host generation left nothing owing it an answer.
 */
export function hasUnansweredStructuredAgentSessionDispatch(
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null
): boolean {
  return submissions.some((submission) =>
    isUnansweredStructuredAgentSessionDispatch(submission, currentFence)
  )
}
