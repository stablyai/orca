import type { StructuredAgentSubmission } from './structured-agent-session-submissions'
import { hasUnansweredStructuredAgentSessionDispatch } from '../requests/structured-agent-session-unanswered-dispatch'

/** Host operational projections scope current generations; clients without scope retain legacy running-turn/pending-prompt/unanswered-send reads. */
export type StructuredAgentSessionWorkScope = {
  /** Whether the live generation's execution produced this item. */
  isCurrentItem: (itemId: string) => boolean
  /** Owed by the live generation, or accepted but not yet handed over. */
  owesSend: (submission: StructuredAgentSubmission) => boolean
}

/** Share the main-agent Working/Stop rule: running turn or unanswered send, scoped by the host projection when available. */
export function isStructuredAgentSessionMainAgentWorking(
  activeTurnId: string | null,
  submissions: readonly StructuredAgentSubmission[],
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): boolean {
  return (
    activeTurnId !== null ||
    (scope
      ? submissions.some(scope.owesSend)
      : hasUnansweredStructuredAgentSessionDispatch(submissions, currentFence))
  )
}
