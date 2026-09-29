import type { OrderedHeaderRect } from './ordered-header-drag-dom'

const INDICATOR_GAP_PX = 4

/** Where a pointer at `pointerY` would drop among the mounted header rects. */
export function getHeaderDropPosition(
  rects: readonly OrderedHeaderRect[],
  container: HTMLElement,
  pointerY: number
): { dropIndex: number; dropIndicatorY: number } | null {
  if (rects.length === 0) {
    return null
  }
  const containerRect = container.getBoundingClientRect()
  const localY = pointerY - containerRect.top + container.scrollTop
  let insertBefore = rects.length
  for (let i = 0; i < rects.length; i++) {
    const mid = (rects[i].top + rects[i].bottom) / 2
    if (localY < mid) {
      insertBefore = i
      break
    }
  }
  const rawIndicatorY =
    insertBefore >= rects.length
      ? rects.at(-1)!.bottom + INDICATOR_GAP_PX
      : Math.max(0, rects[insertBefore].top - INDICATOR_GAP_PX)
  return {
    dropIndex: insertBefore,
    dropIndicatorY: Math.max(container.scrollTop, rawIndicatorY)
  }
}

/**
 * The full order after a drop, or null when nothing moves. Why anchor on a
 * neighbour id rather than the drop index: with a virtualized tier the rects
 * cover only the mounted headers, so the index means nothing against the full
 * order. A drop past the last mounted header lands after it, not at the end.
 */
export function reorderHeaderIdsForDrop(args: {
  ids: readonly string[]
  movedId: string
  rects: readonly OrderedHeaderRect[]
  dropIndex: number
}): string[] | null {
  const { ids, movedId, rects, dropIndex } = args
  if (!ids.includes(movedId)) {
    return null
  }
  const anchor = dropIndex < rects.length ? rects[dropIndex] : undefined
  const anchorId = anchor?.id ?? rects.at(-1)?.id
  if (anchorId === undefined || anchorId === movedId) {
    return null
  }
  const next = ids.filter((id) => id !== movedId)
  const anchorIndex = next.indexOf(anchorId)
  if (anchorIndex === -1) {
    return null
  }
  next.splice(anchor ? anchorIndex : anchorIndex + 1, 0, movedId)
  return next.every((id, index) => id === ids[index]) ? null : next
}
