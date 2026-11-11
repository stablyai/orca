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

/** The message each row follows: the last top-level message at or before its time. */
export function placeNativeChatTimedRows(
  slots: readonly NativeChatTranscriptSlot[],
  rows: readonly NativeChatTimedRow[]
): NativeChatTimedRowPlacement {
  const dated = slots.flatMap((slot) =>
    slot.kind === 'message' && slot.depth === 0 && slot.message.timestamp !== null
      ? [{ id: slot.message.id, at: slot.message.timestamp }]
      : []
  )
  const afterMessage = new Map<string, NativeChatTimedRow[]>()
  const unplaced: NativeChatTimedRow[] = []
  for (const row of rows.toSorted((a, b) => a.at - b.at)) {
    const anchor = dated.findLast((message) => message.at <= row.at)
    if (anchor) {
      afterMessage.set(anchor.id, [...(afterMessage.get(anchor.id) ?? []), row])
    } else {
      unplaced.push(row)
    }
  }
  return { afterMessage, unplaced }
}

/** Stable while no row changes the message it follows, so streaming text does not redraw every row. */
export function useNativeChatTimedRows(
  slots: readonly NativeChatTranscriptSlot[],
  rows: readonly NativeChatTimedRow[] | undefined
): NativeChatTimedRowPlacement | null {
  const placement = useMemo(
    () => (rows?.length ? placeNativeChatTimedRows(slots, rows) : null),
    [slots, rows]
  )
  const signature = placement
    ? [
        ...[...placement.afterMessage].map(
          ([id, placed]) => `${id}:${placed.map(({ key }) => key).join(',')}`
        ),
        `-:${placement.unplaced.map(({ key }) => key).join(',')}`
      ].join('|')
    : ''
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the signature and rows say when placement changes.
  return useMemo(() => placement, [signature, rows])
}
