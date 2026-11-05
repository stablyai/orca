import { finishAgentSessionSteps } from './agent-session-projection-steps'
// Conversation commands (e.g. /compact) are not user requests; previews/verdicts/completion/resume skip their entries and turns.

import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from './journal/agent-session-journal-types'
import { readAgentJournalTurn } from './lifecycle/agent-session-turn-record'

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
  return finishAgentSessionSteps(structuredAgentSessionCommandTurnItemIdsSteps(items))
}

export function* structuredAgentSessionCommandTurnItemIdsSteps(
  items: readonly AgentJournalRenderItem[]
): Generator<void, ReadonlySet<string>> {
  const bodies = new Map<string, AgentJournalItemBody>()
  for (const item of items) {
    bodies.set(item.itemId, item.body)
    yield
  }
  const ids = new Set<string>()
  for (const item of items) {
    yield

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
  commandTurnItemIds: Pick<ReadonlySet<string>, 'has'>
): boolean {
  const scope = item.turnScope
  return (
    isStructuredAgentSessionCommandEntry(item.body) ||
    (scope?.kind === 'turn' && commandTurnItemIds.has(scope.turnItemId))
  )
}
