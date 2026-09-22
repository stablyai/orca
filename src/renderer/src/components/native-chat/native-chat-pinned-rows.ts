// Rows the transcript keeps mounted no matter where the window sits, and the
// range extraction that folds them into the virtualizer's own range.

/** The virtualizer's range, restated so this module needs nothing from the lib. */
export type NativeChatWindowRange = {
  startIndex: number
  endIndex: number
  overscan: number
  count: number
}

export type NativeChatPinnedRowsInput = {
  count: number
  /** Row holding a diff the transcript was asked to reveal; it has to be mounted
   *  for its card to expand and report where to scroll. */
  revealIndex?: number | null
}

/** Indexes that stay mounted outside the window.
 *
 *  The last row is pinned because it is the live one: a running tool announces
 *  itself through `aria-live`, which says nothing from a row that isn't in the
 *  document, and its measured height is what keeps the bottom pin honest while
 *  a turn streams. */
export function nativeChatPinnedRowIndexes({
  count,
  revealIndex
}: NativeChatPinnedRowsInput): ReadonlySet<number> {
  const pinned = new Set<number>()
  if (count <= 0) {
    return pinned
  }
  pinned.add(count - 1)
  if (revealIndex != null && revealIndex >= 0 && revealIndex < count) {
    pinned.add(revealIndex)
  }
  return pinned
}

/** The window's own range widened by overscan, plus the pinned rows. */
export function nativeChatTranscriptRange(
  range: NativeChatWindowRange,
  pinned: ReadonlySet<number>
): number[] {
  const first = Math.max(range.startIndex - range.overscan, 0)
  const last = Math.min(range.endIndex + range.overscan, range.count - 1)
  const indexes = new Set<number>()
  for (let index = first; index <= last; index += 1) {
    indexes.add(index)
  }
  for (const index of pinned) {
    if (index >= 0 && index < range.count) {
      indexes.add(index)
    }
  }
  return Array.from(indexes).sort((left, right) => left - right)
}
