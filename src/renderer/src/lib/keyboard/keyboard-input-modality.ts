let lastInputWasKeyboard = false

function onKeyDown(event: KeyboardEvent): void {
  // Shortcuts like Cmd+, are commands, not keyboard navigation.
  if (!event.metaKey && !event.ctrlKey && !event.altKey) {
    lastInputWasKeyboard = true
  }
}

function onPointerDown(): void {
  lastInputWasKeyboard = false
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Capture on window so handlers that stop propagation can't hide the input.
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('mousedown', onPointerDown, true)
}

/** Whether the latest user input was keyboard, so focus that follows it is keyboard navigation. */
export function isKeyboardInputModality(): boolean {
  return lastInputWasKeyboard
}
