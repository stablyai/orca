import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatTurnJournal } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-membership'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { compareAgentJournalItems } from '../../../../../../shared/agent-session/journal/agent-session-journal-position'
import { readAgentJournalTurn } from '../../../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'

// Subagent rows are grouped by the parent turn they belong to; these checks prove that grouping still holds.

/** User rows and turn records anchor turns; neither may change for earlier rows to keep their turn. */
function opensOrRecordsTurn(item: AgentJournalRenderItem): boolean {
  return (
    (item.body.kind === 'message' && item.body.role === 'user') ||
    readAgentJournalTurn(item.body) !== null
  )
}

function turnItemId(item: AgentJournalRenderItem): string | undefined {
  return item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : undefined
}

/** The journal items appended since `before`, by id, when every turn input of the earlier items is unchanged;
 * null when a turn input changed. Turn keys read user rows, turn records, scopes, submissions and the latest turn. */
export function appendedTurnNeutralItems(
  before: NativeChatTurnJournal | null | undefined,
  after: NativeChatTurnJournal | null | undefined
): ReadonlyMap<string, AgentJournalRenderItem> | null {
  if (!before || !after) {
    return before === after ? new Map() : null
  }
  if (
    before.submissions !== after.submissions ||
    before.working !== after.working ||
    JSON.stringify(before.latestTurn) !== JSON.stringify(after.latestTurn) ||
    after.items.length < before.items.length
  ) {
    return null
  }
  for (const [index, item] of before.items.entries()) {
    const next = after.items[index]!
    if (
      item !== next &&
      (item.itemId !== next.itemId ||
        item.agentId !== next.agentId ||
        compareAgentJournalItems(item, next) !== 0 ||
        item.turnScope?.kind !== next.turnScope?.kind ||
        turnItemId(item) !== turnItemId(next) ||
        opensOrRecordsTurn(item) ||
        opensOrRecordsTurn(next))
    ) {
      return null
    }
  }
  const appended = new Map<string, AgentJournalRenderItem>()
  for (const item of after.items.slice(before.items.length)) {
    if (opensOrRecordsTurn(item)) {
      return null
    }
    appended.set(item.itemId, item)
  }
  return appended
}

/** Each journal turn's key as drawn on its subagent rows, for a host that states turn scopes. */
export function subagentTurnKeys(
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>,
  items: readonly AgentJournalRenderItem[]
): Map<string, string | undefined> {
  const byId = new Map(items.map((item) => [item.itemId, item]))
  const keys = new Map<string, string | undefined>()
  for (const rows of subagentRows.values()) {
    for (const { message, turnKey } of rows) {
      const turn = byId.get(message.id)
      const id = turn && turnItemId(turn)
      if (id !== undefined) {
        keys.set(id, turnKey)
      }
    }
  }
  return keys
}

/** An appended subagent row's turn key, read from an earlier row of the same turn; undefined when unknown. */
export function appendedSubagentTurnKey(
  message: NativeChatMessage,
  appendedItems: ReadonlyMap<string, AgentJournalRenderItem>,
  turnKeys: ReadonlyMap<string, string | undefined>
): { turnKey: string | undefined } | undefined {
  const item = appendedItems.get(message.id)
  if (!item) {
    return undefined
  }
  const id = turnItemId(item)
  if (id === undefined) {
    // Unscoped or unknown-scope rows own no turn.
    return { turnKey: undefined }
  }
  return turnKeys.has(id) ? { turnKey: turnKeys.get(id) } : undefined
}
