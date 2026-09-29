import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { activeStructuredAgentSessionTurnId } from './structured-agent-session-live-turn'
import { isStructuredAgentSessionMainAgentWorking } from './structured-agent-session-main-agent-working'

/** A running turn or an unanswered send: what a `working` status means, and what an `attention`
 *  status hides beneath its pending prompt. The main-agent rule, read from the journal's items. */
export function owesStructuredAgentSessionWork(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null
): boolean {
  return isStructuredAgentSessionMainAgentWorking(
    activeStructuredAgentSessionTurnId(items),
    submissions,
    currentFence
  )
}
