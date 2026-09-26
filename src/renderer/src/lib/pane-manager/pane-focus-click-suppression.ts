export type FocusClickSuppressionInput = {
  /** Whether the clicked pane was already the active one when the gesture began. */
  paneWasActive: boolean
  /** False when the pointer landed on a pane-local app control rather than the terminal. */
  focusesTerminal: boolean
  mouseTrackingMode: string
  pointerType: string
  isPrimaryPointer: boolean
  button: number
  /** Any of shift/meta/ctrl/alt — every one of them is a deliberate bypass. */
  modifierHeld: boolean
}

/**
 * Whether the click that reactivates a pane should stop before xterm sees it.
 *
 * Only a mouse-tracking TUI turns such a click into input, and there the row
 * under the pointer can be a prompt option the user never meant to answer.
 */
export function shouldSwallowFocusClick(input: FocusClickSuppressionInput): boolean {
  if (input.paneWasActive || !input.focusesTerminal) {
    return false
  }
  // Why: without tracking the click only moves the cursor or starts a selection,
  // and swallowing it would break click-to-place in an inactive pane.
  if (input.mouseTrackingMode === 'none') {
    return false
  }
  // Why: touch and pen do not always produce the compatibility mousedown this
  // arms for, which would leave the verdict to be spent on a later real click.
  if (input.pointerType !== 'mouse' || !input.isPrimaryPointer) {
    return false
  }
  // Why: middle-click paste and the context menu are routed by button, and
  // shift/modifier clicks are the documented way to reach past mouse tracking.
  return input.button === 0 && !input.modifierHeld
}
