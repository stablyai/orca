// Which part of the host's conversation outline the rail may use.
//
// The loaded window is a contiguous suffix of the journal and is authoritative for
// everything it covers, so the outline only ever speaks for messages older than it.
// The outline is current through `cursor.sequence`; if that falls short of the
// loaded window's first row there is a gap no source covers, and a rail built over
// the gap would silently skip messages. That outline is stale: the rail shows
// loaded messages only until a fresh one arrives.

import type { AgentSessionConversationOutline } from '../../../../shared/agent-session-conversation-outline'
import type { NativeChatRailOutlineEntry } from './native-chat-message-rail-items'

export type StructuredRailOutlineWindow = {
  epoch: string | null
  /** Sequence of the oldest loaded journal item; null when nothing is loaded. */
  oldestLoadedSequence: number | null
  hasOlder: boolean
}

export type StructuredRailOutlineView =
  /** Everything is loaded, or nothing is: the loaded rail is already the whole thread. */
  | { kind: 'complete' }
  | { kind: 'fresh'; entries: readonly NativeChatRailOutlineEntry[] }
  | { kind: 'stale' }

const COMPLETE: StructuredRailOutlineView = { kind: 'complete' }
const STALE: StructuredRailOutlineView = { kind: 'stale' }

const views = new WeakMap<
  AgentSessionConversationOutline,
  { edge: number; count: number; view: StructuredRailOutlineView }
>()

export function selectStructuredRailOutline(
  outline: AgentSessionConversationOutline | null,
  window: StructuredRailOutlineWindow
): StructuredRailOutlineView {
  const { epoch, oldestLoadedSequence, hasOlder } = window
  if (!hasOlder || epoch === null || oldestLoadedSequence === null) {
    return COMPLETE
  }
  if (
    !outline ||
    outline.cursor.epoch !== epoch ||
    outline.cursor.sequence < oldestLoadedSequence - 1
  ) {
    return STALE
  }
  // The rail's merge sees one array until the covered entries change. A trimmed live
  // window moves its edge on every new row, and usually past no user message.
  const cached = views.get(outline)
  if (cached?.edge === oldestLoadedSequence) {
    return cached.view
  }
  let count = 0
  for (const entry of outline.entries) {
    if (entry.sequence < oldestLoadedSequence) {
      count += 1
    }
  }
  // "Older than the edge" only grows or shrinks with it, so an equal count is the same set.
  const view: StructuredRailOutlineView =
    cached?.count === count
      ? cached.view
      : {
          kind: 'fresh',
          entries: outline.entries
            .filter((entry) => entry.sequence < oldestLoadedSequence)
            .map((entry) => ({
              id: entry.itemId,
              text: entry.preview,
              hasImages: entry.imageCount > 0
            }))
        }
  views.set(outline, { edge: oldestLoadedSequence, count, view })
  return view
}
