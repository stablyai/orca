/** Timed rows on the desktop's transcript slots: each draws after the newest message before it. */
import { useMemo } from 'react'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import { anchorNativeChatTimedRows } from '../../../../../../shared/native-chat/transcript/native-chat-timed-row-anchors'

export type NativeChatTimedRow = { key: string; at: number; node: React.ReactNode }

export type NativeChatTimedRowPlacement = {
  /** Keyed by message id: the rows drawn after that message, oldest first. */
  afterMessage: ReadonlyMap<string, readonly NativeChatTimedRow[]>
  /** Rows in a conversation with no dated message, drawn at its end. */
  unplaced: readonly NativeChatTimedRow[]
}

// Separators no key or message id contains.
const FIELD = '\u0000'
const ROW = '\u0001'

function datedMessages(slots: readonly NativeChatTranscriptSlot[]): { id: string; at: number }[] {
  return slots.flatMap((slot) =>
    slot.kind === 'message' && slot.message.timestamp !== null
      ? [{ id: slot.message.id, at: slot.message.timestamp }]
      : []
  )
}

/** Stable while no row changes the message it follows, so streaming text does not redraw every row. */
export function useNativeChatTimedRows(
  slots: readonly NativeChatTranscriptSlot[],
  rows: readonly NativeChatTimedRow[] | undefined
): NativeChatTimedRowPlacement | null {
  // A string, so the memo below sees a change only when some row's anchor does.
  const anchors = rows?.length
    ? anchorNativeChatTimedRows(datedMessages(slots), rows)
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
