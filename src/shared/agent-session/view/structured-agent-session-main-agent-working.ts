import { finishAgentSessionSteps } from '../agent-session-projection-steps'
import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'
import { isUnansweredStructuredAgentSessionDispatch } from '../requests/structured-agent-session-unanswered-dispatch'

/** Host operational projections scope current generations; clients without scope retain legacy running-turn/pending-prompt/unanswered-send reads. */
export type StructuredAgentSessionWorkScope = {
  /** Whether the live generation's execution produced this item. */
  isCurrentItem: (itemId: string) => boolean
  /** Owed by the live generation, or accepted but not yet handed over. */
  owesSend: (submission: AgentJournalSubmission) => boolean
}

/** Share the main-agent Working/Stop rule: running turn or unanswered send, scoped by the host projection when available. */
export function isStructuredAgentSessionMainAgentWorking(
  activeTurnId: string | null,
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): boolean {
  return finishAgentSessionSteps(
    isStructuredAgentSessionMainAgentWorkingSteps(activeTurnId, submissions, currentFence, scope)
  )
}

export function* isStructuredAgentSessionMainAgentWorkingSteps(
  activeTurnId: string | null,
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): Generator<void, boolean> {
  if (activeTurnId !== null) {
    return true
  }
  for (const submission of submissions) {
    yield
    if (
      scope
        ? scope.owesSend(submission)
        : isUnansweredStructuredAgentSessionDispatch(submission, currentFence)
    ) {
      return true
    }
  }
  return false
}
