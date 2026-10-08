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

/** Hide the jump affordance while the latest output is still nearby. */
export const NATIVE_CHAT_BOTTOM_THRESHOLD_PX = 48

/** Distance in px from the bottom edge of the scroll range. */
export function distanceFromBottom(geometry: ScrollGeometry): number {
  return Math.max(0, geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop)
}

/** Whether the viewport is inside the requested distance from the bottom. */
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

/** Allow bottom rounding noise without following a reader who moved up a line. */
export const NATIVE_CHAT_FOLLOW_REARM_PX = 4

export type FollowIntent = {
  following: boolean
  /** Whether the scroll event matches an offset the application registered. */
  programmatic: boolean
  geometry: ScrollGeometry
  /** Distance from the end at the previous scroll event. */
  previousDistanceFromEnd: number
  /** Whether a jump to a row is still travelling there. Rows it passes measure
   *  shorter than estimated, the content shrinks, and the browser clamps the view
   *  onto the end: that is the end arriving, not the reader. */
  settling: boolean
}

/** Passive offsets preserve following; detached views rearm only while closing on the actual tail. */
export function nextFollowingEnd(intent: FollowIntent): boolean {
  if (intent.following || intent.programmatic || intent.settling) {
    return intent.following
  }
  if (distanceFromBottom(intent.geometry) > intent.previousDistanceFromEnd) {
    return false
  }
  return isNearBottom(intent.geometry, NATIVE_CHAT_FOLLOW_REARM_PX)
}

/** A reader input that can move the transcript, reduced to what decides following. */
export type ReaderGesture =
  | { kind: 'wheel'; deltaY: number; zoom: boolean }
  | { kind: 'touch-drag' }
  | { kind: 'scrollbar-press' }
  | { kind: 'content-press' }
  | { kind: 'key'; key: string; shift?: boolean }

const KEYS_AWAY_FROM_END = new Set(['PageUp', 'Home', 'ArrowUp'])
const KEYS_TOWARD_END = new Set(['PageDown', 'End', 'ArrowDown'])

/** The direction a gesture scrolls: -1 up, 1 down, 0 when it does not scroll. */
export function readerGestureDirection(gesture: ReaderGesture): -1 | 0 | 1 {
  if (gesture.kind === 'wheel') {
    return gesture.zoom || gesture.deltaY === 0 ? 0 : gesture.deltaY < 0 ? -1 : 1
  }
  if (gesture.kind === 'key') {
    if (gesture.key === ' ') {
      return gesture.shift ? -1 : 1
    }
    return KEYS_AWAY_FROM_END.has(gesture.key) ? -1 : KEYS_TOWARD_END.has(gesture.key) ? 1 : 0
  }
  return 0
}

/** Gestures that cannot leave the tail must not strand a following view without a scroll event. */
export function readerGestureLeavesEnd(gesture: ReaderGesture, geometry: ScrollGeometry): boolean {
  const contentAbove = geometry.scrollTop > 0
  const awayFromEnd = !isNearBottom(geometry, NATIVE_CHAT_FOLLOW_REARM_PX)
  switch (gesture.kind) {
    case 'wheel':
      return readerGestureDirection(gesture) < 0 && contentAbove
    case 'scrollbar-press':
      return contentAbove
    // A touch's direction is not observable; it leaves once its drag has carried the view away.
    case 'touch-drag':
    case 'content-press':
      return awayFromEnd
    case 'key': {
      const direction = readerGestureDirection(gesture)
      return direction < 0 ? contentAbove : direction > 0 && awayFromEnd
    }
  }
}
