import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { agentJournalTurnForkPoint, readAgentJournalTurn } from './agent-session-turn-record'
import { nativeChatProseToMarkdown } from './native-chat-prose'

/** The rows that offer "fork from this turn": in each turn the host would fork (it shares
 *  `agentJournalTurnForkPoint`), the last words the session's own agent wrote. */
export function selectStructuredAgentForkRows(
  agent: string,
  items: readonly AgentJournalRenderItem[]
): ReadonlySet<string> {
  const forkableTurns = new Set<string>()
  const lastAnswerByTurn = new Map<string, string>()
  for (const item of items) {
    if (agentJournalTurnForkPoint(agent, readAgentJournalTurn(item.body)) !== null) {
      forkableTurns.add(item.itemId)
    } else if (
      item.turnScope?.kind === 'turn' &&
      item.agentId === undefined &&
      item.body.kind === 'message' &&
      item.body.role === 'assistant' &&
      // Words are what a row's controls hang under; tools alone, or empty text, draw none.
      nativeChatProseToMarkdown(item.body.blocks).length > 0
    ) {
      lastAnswerByTurn.set(item.turnScope.turnItemId, item.itemId)
    }
  }
  // A turn's record can follow its rows, so the turns are only all known once the pass ends.
  const rows = new Set<string>()
  for (const [turnItemId, itemId] of lastAnswerByTurn) {
    if (forkableTurns.has(turnItemId)) {
      rows.add(itemId)
    }
  }
  return rows
}
