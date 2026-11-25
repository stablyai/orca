import type { AgentJournalRenderItem } from './agent-session-journal-types'

/** The journal rows a turn's opener is read from. */
export type AgentJournalTurnOpenerRows = {
  items: readonly AgentJournalRenderItem[]
  /** Turn rows' `userItemId`s the journal keeps under another id: a Claude send's echo names the
   *  provider's id, an alias of the send's row. Ids not listed are kept as named. */
  openerIds: ReadonlyMap<string, string>
}

/** The message a turn row's `userItemId` names, followed through the journal's aliases. */
export function agentJournalTurnOpener(
  rows: AgentJournalTurnOpenerRows,
  userItemId: string
): AgentJournalRenderItem | null {
  const itemId = rows.openerIds.get(userItemId) ?? userItemId
  return rows.items.find((item) => item.itemId === itemId) ?? null
}
