export type NativeChatWindowRange = {
  startIndex: number
  endIndex: number
  overscan: number
  count: number
}

export type NativeChatPinnedRowsInput = {
  count: number
  /** Mount reveal targets before their cards expand and report scroll positions. */
  revealIndex?: number | null
  /** Keep the New marker mounted so it can reveal itself and detect reader replies. */
  newRowsMarkerIndex?: number | null
}

/** Pin the live tail for aria-live announcements and measured-height accuracy during streaming. */
export function nativeChatPinnedRowIndexes({
  count,
  revealIndex,
  newRowsMarkerIndex
}: NativeChatPinnedRowsInput): ReadonlySet<number> {
  const pinned = new Set<number>()
  if (count <= 0) {
    return pinned
  }
  pinned.add(count - 1)
  for (const index of [revealIndex, newRowsMarkerIndex]) {
    if (index != null && index >= 0 && index < count) {
      pinned.add(index)
    }
  }
  return pinned
}

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
