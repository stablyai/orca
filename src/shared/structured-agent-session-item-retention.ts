// How much of a session's journal a client keeps in memory.

import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { isRootAgentJournalItem } from './agent-session-journal-producer'

// Well above the renderer's initial read window (300) plus a page, so only genuinely
// long live sessions trim; anything trimmed is still reachable by paging older.
// Counted in the session's own rows, the rows a reader sees: a subagent's rows sit behind its
// roster entry on desktop and are not drawn on mobile, so they cannot crowd the conversation out.
export const MAX_RETAINED_OWN_ITEMS = 1024
// Bounds the memory and the rows every live delta re-derives the transcript over.
export const MAX_RETAINED_ITEMS = 4 * MAX_RETAINED_OWN_ITEMS

export function ownItemCount(items: readonly AgentJournalRenderItem[]): number {
  return items.reduce((count, item) => (isRootAgentJournalItem(item) ? count + 1 : count), 0)
}

/** Everything after the newest own row past `ownLimit`, so a trim only ever cuts through one of
 *  the session's own rows: a paged-in run of a subagent's rows at the head stays until an own row
 *  pushes it out. With no subagent rows this is the newest `ownLimit` rows. */
export function trimRetainedItems(
  items: AgentJournalRenderItem[],
  ownLimit: number,
  cap: number
): AgentJournalRenderItem[] {
  let start = Math.max(0, items.length - cap)
  let own = 0
  for (let index = items.length - 1; index >= start; index -= 1) {
    if (!isRootAgentJournalItem(items[index])) {
      continue
    }
    own += 1
    if (own > ownLimit) {
      start = index + 1
      break
    }
  }
  return start === 0 ? items : items.slice(start)
}
