import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { activeStructuredAgentSessionTurnId } from './structured-agent-session-live-turn'
import {
  isStructuredAgentSessionMainAgentWorking,
  type StructuredAgentSessionWorkScope
} from './structured-agent-session-main-agent-working'
import { agentSessionCurrentContextRows } from './agent-session-context-clear'

/** Journal main-agent rule: running turn or unanswered send, including work hidden beneath an attention prompt. */
export function owesStructuredAgentSessionWork(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): boolean {
  const current = agentSessionCurrentContextRows(items, submissions)
  return isStructuredAgentSessionMainAgentWorking(
    activeStructuredAgentSessionTurnId(
      current.items,
      scope && ((item) => scope.isCurrentItem(item.itemId))
    ),
    current.submissions,
    currentFence,
    scope
  )
}
