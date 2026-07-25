/**
 * Run `onGuestFocus` when focus moves into an embedded `<webview>` guest (browser pane, mobile emulator).
 *
 * Why: interacting inside a guest never reaches the host document as a `pointerdown`, so Radix's
 * outside-press dismissal cannot retire an open hover card, and it deliberately ignores focus leaving the
 * layer. Focus landing on the `<webview>` is the one host-visible signal that the user has moved into the
 * guest, which is when a card floating over that pane has to go.
 */
const GUEST_FOCUS_EVENT = 'focusin'

export function addWebviewGuestFocusListener(
  onGuestFocus: () => void,
  target: Document = document
): () => void {
  const handleFocusIn = (event: Event): void => {
    const node = event.target
    if (!(node instanceof Element) || !node.closest('webview')) {
      return
    }
    onGuestFocus()
  }
  target.addEventListener(GUEST_FOCUS_EVENT, handleFocusIn, true)
  return () => target.removeEventListener(GUEST_FOCUS_EVENT, handleFocusIn, true)
}
