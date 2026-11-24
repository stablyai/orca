import { isImeOwnedKeyboardEvent } from './ime-composition-keyboard-event'

/** Overlay dismissal runs in document capture, before a text field can stop propagation. */
export function handleImeOverlayEscape(
  event: KeyboardEvent,
  onEscapeKeyDown?: (event: KeyboardEvent) => void
): void {
  if (isImeOwnedKeyboardEvent(event)) {
    event.preventDefault()
    return
  }
  onEscapeKeyDown?.(event)
}
