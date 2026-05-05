export function shouldIgnoreTerminalMenuPointerDownOutside(args: {
  openedAtMs: number
  nowMs: number
}): boolean {
  const { openedAtMs, nowMs } = args
  // Why: only the opening gesture should be ignored. After that brief window,
  // outside clicks including right-click and macOS control-click must dismiss
  // normally so the terminal menu behaves like the app's other context menus.
  return nowMs - openedAtMs < 100
}
