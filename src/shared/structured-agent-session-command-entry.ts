// Conversation commands (e.g. /compact) are not user requests; previews/verdicts/completion/resume skip their entries and turns.

import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'

export function isStructuredAgentSessionCommandEntry(
  body: AgentJournalItemBody | null | undefined
): boolean {
  return body?.kind === 'message' && body.command !== undefined
}

export function isStructuredAgentSessionCommandTurn(
  turn: Pick<AgentJournalTurnLifecycle, 'userItemId'> | null | undefined,
  bodyOf: (itemId: string) => AgentJournalItemBody | null | undefined
): boolean {
  return (
    turn?.userItemId !== undefined && isStructuredAgentSessionCommandEntry(bodyOf(turn.userItemId))
  )
}

export function structuredAgentSessionCommandTurnItemIds(
  items: readonly AgentJournalRenderItem[]
): ReadonlySet<string> {
  const bodies = new Map(items.map((item) => [item.itemId, item.body]))
  const ids = new Set<string>()
  for (const item of items) {
    if (
      isStructuredAgentSessionCommandTurn(readAgentJournalTurn(item.body), (id) => bodies.get(id))
    ) {
      ids.add(item.itemId)
    }
  }
  return ids
}

export function isStructuredAgentSessionCommandRow(
  item: Pick<AgentJournalRenderItem, 'body' | 'turnScope'>,
  commandTurnItemIds: ReadonlySet<string>
): boolean {
  const scope = item.turnScope
  return (
    isStructuredAgentSessionCommandEntry(item.body) ||
    (scope?.kind === 'turn' && commandTurnItemIds.has(scope.turnItemId))
  )
}
