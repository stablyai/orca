let lastPressWasTouchInput = false

// Why capture at load: a menu's rows mount right after the press that opened it, so the
// listeners must already be recording when that first press happens.
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (event) => {
      lastPressWasTouchInput = event.pointerType === 'touch'
    },
    { capture: true, passive: true }
  )
  // A keyboard-opened menu stays compact even after an earlier tap.
  window.addEventListener(
    'keydown',
    () => {
      lastPressWasTouchInput = false
    },
    { capture: true, passive: true }
  )
}

/** Whether the latest press was a touch, e.g. the tap that just opened a menu. */
export function lastPressWasTouch(): boolean {
  return lastPressWasTouchInput
}
