import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { structuredAgentSessionTurnAssistantMessage } from './structured-agent-session-latest-request'
import { journalItemHasSideEffects } from './tool-call-side-effects'

/** What a turn's end tells the request it answered: its newest root prose
 *  (structuredAgentSessionTurnAssistantMessage), and whether a tool call inside it, a sub-agent's
 *  included, may have changed something (journalItemHasSideEffects); reads alone don't count. */
export function structuredAgentSessionTurnReply(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string
): { prose: string; toolsRan: boolean } {
  return {
    prose: structuredAgentSessionTurnAssistantMessage(items, turnItemId),
    toolsRan: items.some(
      (item) =>
        item.turnScope?.kind === 'turn' &&
        item.turnScope.turnItemId === turnItemId &&
        journalItemHasSideEffects(item.body)
    )
  }
}
