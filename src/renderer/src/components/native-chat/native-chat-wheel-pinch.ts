// Long enough for the matching zoom-changed event to arrive, short enough not to swallow the next shortcut.
const CHAT_WHEEL_PINCH_OWNS_ZOOM_MS = 100

let ownsZoomUntil = 0

export function noteChatWheelPinch(now = Date.now()): void {
  ownsZoomUntil = now + CHAT_WHEEL_PINCH_OWNS_ZOOM_MS
}

export function chatWheelPinchOwnsZoom(now = Date.now()): boolean {
  return now < ownsZoomUntil
}
