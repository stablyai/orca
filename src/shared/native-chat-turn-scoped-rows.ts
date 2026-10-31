import type { AgentJournalRenderItem } from './agent-session-journal-types'

/**
 * What rows scoped to a turn record say about it. `steeredInto`: user rows that joined a running
 * turn. `scopedOpeners`: for a record no anchor names, its first scoped prompt, else the record
 * itself, so a record saved ahead of its rows never borrows another turn's prompt. Only a record no
 * row is scoped to (an older host's) is left to the prompt before it.
 */
export function turnScopedUserRows(
  items: readonly AgentJournalRenderItem[],
  userItemIds: ReadonlySet<string>
) {
  const steeredInto = new Map<string, string>()
  const scopedOpeners = new Map<string, string>()
  for (const item of items) {
    if (item.turnScope?.kind !== 'turn') {
      continue
    }
    const { turnItemId } = item.turnScope
    const user = userItemIds.has(item.itemId)
    if (user) {
      steeredInto.set(item.itemId, turnItemId)
    }
    const opener = scopedOpeners.get(turnItemId)
    if (opener === undefined || (opener === turnItemId && user)) {
      scopedOpeners.set(turnItemId, user ? item.itemId : turnItemId)
    }
  }
  return { steeredInto, scopedOpeners }
}
