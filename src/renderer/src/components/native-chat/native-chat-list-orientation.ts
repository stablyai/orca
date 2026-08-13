// Which end of the message list holds the newest turn. The default chat reads
// downward (newest last, composer underneath); the composer-on-top layout reads
// the transcript newest-first so the live turn stays next to the input.
//
// Why reverse the rendered order instead of `flex-col-reverse`: a reversed flex
// container overflows toward its block-start, which breaks scroll anchoring and
// the paging edge. Rendering newest-first in a normal column keeps the newest
// turn at scrollTop 0, so "pinned to latest" is just "pinned to the top".

import {
  distanceFromBottom,
  NATIVE_CHAT_BOTTOM_THRESHOLD_PX,
  type ScrollGeometry
} from './native-chat-autoscroll'

export type NativeChatListOrientation = 'newest-last' | 'newest-first'

/** Distance from the oldest end within which the next page is requested. */
export const NATIVE_CHAT_LOAD_EARLIER_THRESHOLD_PX = 80

export function nativeChatListOrientation(composerOnTop: boolean): NativeChatListOrientation {
  return composerOnTop ? 'newest-first' : 'newest-last'
}

/** Px between the viewport and the edge that holds the newest turn. */
export function distanceFromLatest(
  orientation: NativeChatListOrientation,
  geometry: ScrollGeometry
): number {
  return orientation === 'newest-first'
    ? Math.max(0, geometry.scrollTop)
    : distanceFromBottom(geometry)
}

/** True when new content should keep the viewport pinned to the newest turn. */
export function isPinnedToLatest(
  orientation: NativeChatListOrientation,
  geometry: ScrollGeometry,
  threshold: number = NATIVE_CHAT_BOTTOM_THRESHOLD_PX
): boolean {
  return distanceFromLatest(orientation, geometry) <= threshold
}

/** Show "jump to latest" only once the user has detached far enough that the
 *  newest turn is actually off-screen. */
export function shouldShowJumpAffordance(
  orientation: NativeChatListOrientation,
  pinnedToLatest: boolean,
  geometry: ScrollGeometry,
  threshold: number = NATIVE_CHAT_BOTTOM_THRESHOLD_PX
): boolean {
  if (pinnedToLatest) {
    return false
  }
  return distanceFromLatest(orientation, geometry) > threshold
}

/** scrollTop that puts the newest turn in view. */
export function latestScrollTop(
  orientation: NativeChatListOrientation,
  geometry: ScrollGeometry
): number {
  return orientation === 'newest-first' ? 0 : geometry.scrollHeight
}

/** True when the viewport has reached the oldest end and history should page in. */
export function isAtOldestEdge(
  orientation: NativeChatListOrientation,
  geometry: ScrollGeometry,
  threshold: number = NATIVE_CHAT_LOAD_EARLIER_THRESHOLD_PX
): boolean {
  return orientation === 'newest-first'
    ? distanceFromBottom(geometry) < threshold
    : geometry.scrollTop < threshold
}

/** Only the newest-last layout needs a prepend anchor: there older turns land
 *  above the viewport and push it down. Newest-first appends them below the
 *  viewport, so scrollTop already points at the same content. */
export function tracksPrependAnchor(orientation: NativeChatListOrientation): boolean {
  return orientation === 'newest-last'
}

/** The list in render order for this orientation (newest-first reverses a copy;
 *  the caller's array is memoized and must not be mutated). */
export function orientNativeChatMessages<T>(
  orientation: NativeChatListOrientation,
  messages: readonly T[]
): readonly T[] {
  return orientation === 'newest-first' ? messages.toReversed() : messages
}
