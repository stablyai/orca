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
}

/** Whether the transcript should still follow the end after this offset.
 *
 *  Application writes preserve intent even when their delayed events arrive
 *  after the end moved. Reader events detach away from the end and reattach on
 *  arriving at it — against the re-arm band, never the wider near-bottom one.
 *  Arriving takes closing on the end: a smooth scroll leaving the end marks only
 *  its landing, and its first unmarked frames still sit inside the band. Measured
 *  against the end, not the offset, so content shrinking under a detached reader
 *  and clamping them onto the end still reattaches. */
export function nextFollowingEnd(intent: FollowIntent): boolean {
  if (intent.programmatic) {
    return intent.following
  }
  if (!intent.following && distanceFromBottom(intent.geometry) > intent.previousDistanceFromEnd) {
    return false
  }
  return isNearBottom(intent.geometry, NATIVE_CHAT_FOLLOW_REARM_PX)
}

/** Whether the transcript follows its end, and if not, what the reader did to stop it. */
export type FollowState =
  | { kind: 'following' }
  | { kind: 'detached'; reason: 'scroll' | 'navigation' }
  /** Stopped only by opening rows, and not scrolled since: closing the last one follows again. */
  | { kind: 'detached'; reason: 'open'; opens: ReadonlySet<string> }

export type FollowEvent =
  | { kind: 'open' | 'close'; row: string }
  | ({ kind: 'scroll' } & Omit<FollowIntent, 'following'>)
  | { kind: 'reveal-latest' }
  | { kind: 'navigate' }

export const FOLLOWING: FollowState = { kind: 'following' }

export function nextFollowState(state: FollowState, event: FollowEvent): FollowState {
  switch (event.kind) {
    case 'open':
      if (state.kind === 'following') {
        return { kind: 'detached', reason: 'open', opens: new Set([event.row]) }
      }
      return state.reason === 'open' && !state.opens.has(event.row)
        ? { ...state, opens: new Set([...state.opens, event.row]) }
        : state
    case 'close': {
      // By identity: a row opened before this detach is not one of its opens.
      if (state.kind === 'following' || state.reason !== 'open' || !state.opens.has(event.row)) {
        return state
      }
      const opens = new Set(state.opens)
      opens.delete(event.row)
      return opens.size === 0 ? FOLLOWING : { ...state, opens }
    }
    case 'scroll':
      if (event.programmatic) {
        return state
      }
      return nextFollowingEnd({ ...event, following: state.kind === 'following' })
        ? FOLLOWING
        : { kind: 'detached', reason: 'scroll' }
    case 'reveal-latest':
      return FOLLOWING
    case 'navigate':
      return { kind: 'detached', reason: 'navigation' }
  }
}
