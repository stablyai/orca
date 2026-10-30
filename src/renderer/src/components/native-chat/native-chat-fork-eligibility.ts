import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../../shared/agent-session-journal-producer'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../../shared/agent-session-turn-record'

export function nativeChatForkEligibleItemIds(
  items: readonly AgentJournalRenderItem[]
): ReadonlySet<string> {
  const completed = new Set(
    items.flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return isRootAgentJournalItem(item) &&
        turn?.state === 'completed' &&
        readAgentJournalTurnOutcome(turn) === 'success'
        ? [item.itemId]
        : []
    })
  )
  return new Set(
    items
      .filter(
        (item) =>
          isRootAgentJournalItem(item) &&
          item.body.kind === 'message' &&
          item.body.role === 'assistant' &&
          item.turnScope?.kind === 'turn' &&
          completed.has(item.turnScope.turnItemId)
      )
      .map((item) => item.itemId)
  )
}
