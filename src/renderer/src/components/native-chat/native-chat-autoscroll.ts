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

/** Distance from the top within which the transcript pages in older history. */
export const NATIVE_CHAT_LOAD_EARLIER_THRESHOLD_PX = 80

export type LoadEarlierIntent = {
  geometry: ScrollGeometry
  /** Offset at the previous scroll event; a prepend or a bottom pin moves down. */
  previousScrollTop: number
  hasMore: boolean
  loadingEarlier: boolean
  itemCount: number
  /** Item count when the last page was asked for, or null if none has been. */
  requestedAtItemCount: number | null
}

/** Whether reaching this offset should page in older history.
 *
 *  Windowing makes the naive "am I near the top?" test unsafe: every row that
 *  resolves its real height changes the content height and re-fires the
 *  observers that ask. So the answer also requires the view to have moved
 *  *upwards* — measurement settling and the bottom pin both move it down — and
 *  requires new items since the last request, which caps a stuck near-top view at
 *  one request per page rather than one per measurement. */
export function shouldLoadEarlier(intent: LoadEarlierIntent): boolean {
  if (!intent.hasMore || intent.loadingEarlier) {
    return false
  }
  if (intent.geometry.scrollTop >= NATIVE_CHAT_LOAD_EARLIER_THRESHOLD_PX) {
    return false
  }
  if (intent.geometry.scrollTop > intent.previousScrollTop) {
    return false
  }
  return intent.requestedAtItemCount !== intent.itemCount
}
