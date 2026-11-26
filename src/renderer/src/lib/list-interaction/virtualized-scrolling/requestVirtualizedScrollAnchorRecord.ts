import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from './useVirtualizedScrollAnchor'

/** Snapshot a mounted scroller’s live top-row anchor in the same tick as external row mutation, avoiding stale click-time anchors. */
export function requestVirtualizedScrollAnchorRecord(
  scrollElement: string | Element | null,
  options?: { deferDomMeasurement: boolean }
): void {
  if (typeof document === 'undefined') {
    return
  }
  const element =
    typeof scrollElement === 'string' ? document.querySelector(scrollElement) : scrollElement
  element?.dispatchEvent(
    options?.deferDomMeasurement
      ? new CustomEvent(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, {
          detail: { deferDomMeasurement: true }
        })
      : new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT)
  )
}

/** Explicit navigation replaces a pending saved/structural target, even when its scroll is a no-op. */
export function supersedeVirtualizedScrollAnchorRestore(
  scrollElement: Element | null,
  targetOffset?: number
): void {
  scrollElement?.dispatchEvent(
    new CustomEvent(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, {
      detail: { cancelRestore: true, targetOffset }
    })
  )
}
