type RightClickPasteMouseEvent = {
  button: number
  ctrlKey: boolean
  preventDefault: () => void
  stopPropagation: () => void
}

/** Consume Orca-owned right-click paste before mouse-aware TUIs can paste again (#25192); Ctrl+right-click retains the menu path and xterm report. */
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
