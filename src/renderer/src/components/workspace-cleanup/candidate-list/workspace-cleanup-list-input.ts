// Only the user's own input counts, including pointer entering or moving over rows (hover), so a
// settle re-sort never moves a row under the pointer. Programmatic scrolls (virtualizer restore,
// scrollIntoView) must not count as interaction.
const USER_INPUT_EVENTS = [
  'wheel',
  'touchmove',
  'pointerdown',
  'pointermove',
  'pointerover',
  'keydown',
  'focusin'
] as const

/** Calls `onInput` on the user's own input inside `target`; returns the unsubscribe. */
export function listenForWorkspaceCleanupListInput(
  target: HTMLElement,
  onInput: () => void
): () => void {
  const controller = new AbortController()
  for (const name of USER_INPUT_EVENTS) {
    target.addEventListener(name, onInput, {
      passive: true,
      capture: true,
      signal: controller.signal
    })
  }
  return () => controller.abort()
}
