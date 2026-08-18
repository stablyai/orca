// Pure auto-scroll logic for the native chat message list. The component owns
// the DOM ref and the imperative scroll; this module owns only the decisions —
// "are we near the bottom?", "should we stick on new content?", "show the jump
// affordance?" — so they can be unit-tested without a scroll container.

/** A scroll container's geometry. Mirrors the three DOM props we read so tests
 *  can pass plain numbers instead of a fake element. */
export type ScrollGeometry = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Pixels from the bottom within which we treat the view as "at the bottom" and
 *  keep it pinned as content arrives. A small slack absorbs sub-pixel rounding
 *  and the height jitter of a streaming last message. */
export const NATIVE_CHAT_BOTTOM_THRESHOLD_PX = 48

/** Distance in px from the bottom edge of the scroll range. */
export function distanceFromBottom(geometry: ScrollGeometry): number {
  return Math.max(0, geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop)
}

/** True when the viewport is close enough to the bottom that new content should
 *  keep it pinned (auto-scroll "attached"). */
export function isNearBottom(
  geometry: ScrollGeometry,
  threshold: number = NATIVE_CHAT_BOTTOM_THRESHOLD_PX
): boolean {
  return distanceFromBottom(geometry) <= threshold
}

/** What to do with a captured load-earlier anchor once layout settles.
 *  `restore` — the older page grew the content, so shift scrollTop to keep the
 *  message the user was reading in place.
 *  `wait` — the read is still in flight; the content may still grow.
 *  `discard` — the read settled without adding history (a full-window read
 *  reports `hasMore` optimistically, and a read can also be discarded as stale
 *  or fail). The anchor must be dropped: held on, it later restores a
 *  minutes-old scroll position instead of letting a new message pin to the
 *  bottom. */
export function resolvePrependAnchor(args: {
  /** Container scrollHeight captured when the load-earlier was requested. */
  anchorScrollHeight: number
  /** Container scrollHeight now. */
  scrollHeight: number
  loadingEarlier: boolean
}): 'restore' | 'wait' | 'discard' {
  if (args.scrollHeight > args.anchorScrollHeight) {
    return 'restore'
  }
  return args.loadingEarlier ? 'wait' : 'discard'
}

/** Whether the "jump to latest" affordance should show: only when the user has
 *  detached (scrolled up) and there is actually scrollable content below. */
export function shouldShowJumpToLatest(
  isStuckToBottom: boolean,
  geometry: ScrollGeometry,
  threshold: number = NATIVE_CHAT_BOTTOM_THRESHOLD_PX
): boolean {
  if (isStuckToBottom) {
    return false
  }
  return distanceFromBottom(geometry) > threshold
}
