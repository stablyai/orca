// Only the user's own input counts: wheel, touch, scrollbar drag, keys, focus, pointerdown.
// Programmatic scrolls (virtualizer restore, scrollIntoView) must not count as interaction.
const USER_INPUT_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown', 'focusin'] as const

/** Calls `onInput` on the user's own input inside `target`; returns the unsubscribe. */
export function listenForWorkspaceCleanupListInput(
  target: HTMLElement,
  onInput: () => void
): () => void {
  for (const name of USER_INPUT_EVENTS) {
    target.addEventListener(name, onInput, { passive: true, capture: true })
  }
  return () => {
    for (const name of USER_INPUT_EVENTS) {
      target.removeEventListener(name, onInput, { capture: true })
    }
  }
}
