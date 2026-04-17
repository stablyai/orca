export function shouldIgnoreTerminalMenuPointerDownOutside(args: {
  openedAtMs: number
  nowMs: number
  button: number
  ctrlKey: boolean
  isMac: boolean
}): boolean {
  const { openedAtMs, nowMs, button, ctrlKey, isMac } = args

  if (nowMs - openedAtMs < 100) {
    return true
  }

  // Why: macOS control-click is a context-menu gesture even though the
  // browser reports it as a primary-button event. Treat it like right-click
  // so the opening gesture does not immediately dismiss the menu.
  if (button === 2 || (isMac && button === 0 && ctrlKey)) {
    return true
  }

  return false
}
