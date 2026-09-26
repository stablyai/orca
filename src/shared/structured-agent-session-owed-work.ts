import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { activeStructuredAgentSessionTurnId } from './structured-agent-session-live-turn'
import { hasUnansweredStructuredAgentSessionDispatch } from './structured-agent-session-unanswered-dispatch'

/** A running turn or an unanswered send: what a `working` status means, and what an `attention`
 *  status hides beneath its pending prompt. */
export function owesStructuredAgentSessionWork(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null
): boolean {
  return (
    activeStructuredAgentSessionTurnId(items) !== null ||
    hasUnansweredStructuredAgentSessionDispatch(submissions, currentFence)
  )
}
