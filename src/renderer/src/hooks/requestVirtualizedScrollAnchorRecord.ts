import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from './useVirtualizedScrollAnchor'

/**
 * Asks a mounted virtualized scroller (matched by selector) to snapshot its
 * current top-row anchor right now. Lets code outside the sidebar — e.g. the
 * store's async worktree removal — capture the live anchor in the same tick it
 * mutates the row list, so the post-mutation restore pins the same visible row
 * instead of recording a stale anchor from an earlier click.
 */
export function requestVirtualizedScrollAnchorRecord(scrollElementSelector: string): void {
  if (typeof document === 'undefined') {
    return
  }
  document
    .querySelector(scrollElementSelector)
    ?.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
}
