/**
 * Returns true when an Enter keydown event should be suppressed for submit actions.
 *
 * Two cases must be blocked:
 *  1. IME composition is active — Enter only confirms the conversion candidate.
 *  2. Shift+Enter inside a textarea — intended as a newline, not a submit.
 */
export function shouldSuppressEnterSubmit(
  event: { isComposing: boolean; shiftKey: boolean },
  isTextarea: boolean
): boolean {
  if (event.isComposing) {
    return true
  }
  if (isTextarea && event.shiftKey) {
    return true
  }
  return false
}
