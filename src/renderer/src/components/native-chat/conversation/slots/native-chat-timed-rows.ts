/** Rows that are not part of the conversation but happened during it, such as a worker's approval:
 *  each draws after the newest message that came before it, so it stays at its own time. */
import { useMemo } from 'react'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

export type NativeChatTimedRow = { key: string; at: number; node: React.ReactNode }

export type NativeChatTimedRowPlacement = {
  /** Keyed by message id: the rows drawn after that message, oldest first. */
  afterMessage: ReadonlyMap<string, readonly NativeChatTimedRow[]>
  /** Rows no loaded message precedes, drawn at the end of the conversation. */
  unplaced: readonly NativeChatTimedRow[]
}

// Separators no key or message id contains.
const FIELD = '\u0000'
const ROW = '\u0001'

/** The message each row follows: the last top-level message at or before its time; null for none. */
function anchorNativeChatTimedRows(
  slots: readonly NativeChatTranscriptSlot[],
  rows: readonly NativeChatTimedRow[]
): [key: string, messageId: string | null][] {
  const dated = slots.flatMap((slot) =>
    slot.kind === 'message' && slot.depth === 0 && slot.message.timestamp !== null
      ? [{ id: slot.message.id, at: slot.message.timestamp }]
      : []
  )
  return rows
    .toSorted((a, b) => a.at - b.at)
    .map((row) => [row.key, dated.findLast((message) => message.at <= row.at)?.id ?? null])
}

/** Stable while no row changes the message it follows, so streaming text does not redraw every row. */
export function useNativeChatTimedRows(
  slots: readonly NativeChatTranscriptSlot[],
  rows: readonly NativeChatTimedRow[] | undefined
): NativeChatTimedRowPlacement | null {
  // A string, so the memo below sees a change only when some row's anchor does.
  const anchors = rows?.length
    ? anchorNativeChatTimedRows(slots, rows)
        .map(([key, messageId]) => `${key}${FIELD}${messageId ?? ''}`)
        .join(ROW)
    : ''
  return useMemo(() => {
    if (!rows?.length) {
      return null
    }
    const byKey = new Map(rows.map((row) => [row.key, row]))
    const afterMessage = new Map<string, NativeChatTimedRow[]>()
    const unplaced: NativeChatTimedRow[] = []
    for (const [key, messageId] of anchors.split(ROW).map((entry) => entry.split(FIELD))) {
      const row = byKey.get(key)
      if (!row) {
        continue
      }
      if (messageId) {
        afterMessage.set(messageId, [...(afterMessage.get(messageId) ?? []), row])
      } else {
        unplaced.push(row)
      }
    }
    return { afterMessage, unplaced }
  }, [anchors, rows])
}
