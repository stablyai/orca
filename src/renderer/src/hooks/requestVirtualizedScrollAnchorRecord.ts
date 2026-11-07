import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from './useVirtualizedScrollAnchor'

/** Snapshot a mounted scroller’s live top-row anchor in the same tick as external row mutation, avoiding stale click-time anchors. */
export function requestVirtualizedScrollAnchorRecord(scrollElementSelector: string): void {
  if (typeof document === 'undefined') {
    return
  }
  document
    .querySelector(scrollElementSelector)
    ?.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
}
