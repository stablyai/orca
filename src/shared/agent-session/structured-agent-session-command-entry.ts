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
  // Status re-derives on every journal write; index only the rare command entries, not every body in history.
  const commands = new Map<string, AgentJournalItemBody>()
  for (const item of items) {
    if (isStructuredAgentSessionCommandEntry(item.body)) {
      commands.set(item.itemId, item.body)
    }
  }
  const ids = new Set<string>()
  if (commands.size === 0) {
    return ids
  }
  for (const item of items) {
    if (
      isStructuredAgentSessionCommandTurn(readAgentJournalTurn(item.body), (id) => commands.get(id))
    ) {
      ids.add(item.itemId)
    }
  }
  return ids
}

export type AgentJournalBodyLookup = (itemId: string) => AgentJournalItemBody | null | undefined

/** Command-turn membership read lazily through an indexed body lookup: only the turns a scan reaches are checked, not all history. */
export function commandTurnsByBody(
  bodyOf: AgentJournalBodyLookup
): Pick<ReadonlySet<string>, 'has'> {
  const known = new Map<string, boolean>()
  return {
    has: (itemId) => {
      let command = known.get(itemId)
      if (command === undefined) {
        command = isStructuredAgentSessionCommandTurn(
          readAgentJournalTurn(bodyOf(itemId) ?? undefined),
          bodyOf
        )
        known.set(itemId, command)
      }
      return command
    }
  }
}

/** Lazy membership when the caller has an indexed body read; otherwise the scan of `items`. */
export function commandTurnsOf(
  items: readonly AgentJournalRenderItem[],
  bodyOf: AgentJournalBodyLookup | undefined
): Pick<ReadonlySet<string>, 'has'> {
  return bodyOf ? commandTurnsByBody(bodyOf) : structuredAgentSessionCommandTurnItemIds(items)
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
