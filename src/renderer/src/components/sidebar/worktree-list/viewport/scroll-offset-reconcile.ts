/**
 * The offset the virtualizer should believe once its remembered one is
 * provably not where the scroll element is, or null when nothing needs fixing.
 *
 * TanStack books a size correction into `scrollOffset` before the element
 * scrolls and only re-reads the element on a scroll event. A write the element
 * cannot honor — the list is shorter than the viewport, or the target sits past
 * the scrollable end — fires no event, so the belief keeps an offset the DOM
 * never reached. Range and sticky-header math then pin a later project header
 * over the first row and leave its own slot empty.
 *
 * Only an unreachable belief is corrected: a reachable difference can be a
 * scroll write whose event has not landed yet, and the event will settle it.
 */
export function getReconciledVirtualScrollOffset(args: {
  believedOffset: number | null | undefined
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  isScrolling: boolean
}): number | null {
  if (args.believedOffset == null || args.isScrolling) {
    return null
  }
  const maxScrollTop = Math.max(0, args.scrollHeight - args.clientHeight)
  if (args.believedOffset <= maxScrollTop + 1) {
    return null
  }
  return Math.min(args.scrollTop, maxScrollTop)
}

type ReconcilableVirtualizer = {
  scrollOffset: number | null
  scrollAdjustments: number
  isScrolling: boolean
}

type ReconcilableScrollElement = Pick<Element, 'scrollTop' | 'scrollHeight' | 'clientHeight'>

/**
 * Re-anchors the virtualizer to its element when its belief is unreachable and
 * reports whether anything changed. Nothing is touched while a scroll is in
 * flight; the caller runs this again when scrolling settles.
 */
export function reconcileVirtualizerScrollOffset(args: {
  virtualizer: ReconcilableVirtualizer
  element: ReconcilableScrollElement
  scrollOffsetRef: { current: number }
}): boolean {
  const { virtualizer, element, scrollOffsetRef } = args
  const reconciled = getReconciledVirtualScrollOffset({
    believedOffset: virtualizer.scrollOffset,
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    isScrolling: virtualizer.isScrolling
  })
  if (reconciled === null) {
    return false
  }
  virtualizer.scrollOffset = reconciled
  virtualizer.scrollAdjustments = 0
  scrollOffsetRef.current = reconciled
  return true
}
