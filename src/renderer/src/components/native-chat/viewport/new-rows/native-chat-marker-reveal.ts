// Arriving rows only ever move the view down: a marker the reader already scrolled past is read.

import { NATIVE_CHAT_BOTTOM_THRESHOLD_PX } from '../scroll/native-chat-autoscroll'

/** Which element the arrival reveal brings to the top of the view. */
export type NativeChatMarkerReveal = 'row' | 'marker'

/** Where the marker and the row drawing it sit in the transcript, and what the reader now sees. */
export type NativeChatMarkerRevealInput = {
  /** The marker's offset from the transcript's content top; null without layout. */
  markerTop: number | null
  /** The offset of the row the marker draws in, or null when it has none. */
  rowTop: number | null
  scrollTop: number
  clientHeight: number
}

/**
 * A chat that follows the end keeps growing behind the reader while the window is unfocused. On the
 * window's return the first row that arrived sits far above the viewport, so revealing it would drag
 * the reader back into older messages and stop the transcript following the reply still streaming.
 */
export function nativeChatMarkerRevealTarget({
  markerTop,
  rowTop,
  scrollTop,
  clientHeight
}: NativeChatMarkerRevealInput): NativeChatMarkerReveal | null {
  if (markerTop === null) {
    return null
  }
  // Behind the viewport's top edge the reader has already read past this marker.
  if (markerTop < scrollTop) {
    return null
  }
  // Preserve a reader parked above new rows; replies can still be short while paced rendering catches up.
  if (markerTop - (scrollTop + clientHeight) > NATIVE_CHAT_BOTTOM_THRESHOLD_PX) {
    return null
  }
  // A row above the viewport's top edge would scroll the reader upward; reveal the marker instead.
  if (rowTop !== null && rowTop < scrollTop) {
    return 'marker'
  }
  // Reveal the prompt's row unless it would leave the marker too low in the viewport.
  return markerTop - (rowTop ?? markerTop) < clientHeight / 2 ? 'row' : 'marker'
}
