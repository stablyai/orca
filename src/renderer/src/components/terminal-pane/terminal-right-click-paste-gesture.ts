type RightClickPasteMouseEvent = {
  button: number
  ctrlKey: boolean
  preventDefault: () => void
  stopPropagation: () => void
}

/**
 * Why: with "Right-click to paste" on, Orca owns the right button. xterm would
 * otherwise report the press to a mouse-tracking TUI, and Codex pastes the
 * clipboard on that report itself, so one click pasted twice (#25192).
 * Ctrl+right-click stays the app menu, so that press still reaches xterm.
 */
export function isTerminalRightClickPasteGesture(
  event: Pick<RightClickPasteMouseEvent, 'button' | 'ctrlKey'>,
  rightClickToPaste: boolean
): boolean {
  return rightClickToPaste && event.button === 2 && !event.ctrlKey
}

/** Stop the press before xterm's listener and keep the focus xterm would have taken. */
export function claimTerminalRightClickPasteMouseDown(
  event: RightClickPasteMouseEvent,
  terminal: { focus: () => void }
): void {
  event.preventDefault()
  event.stopPropagation()
  terminal.focus()
}
