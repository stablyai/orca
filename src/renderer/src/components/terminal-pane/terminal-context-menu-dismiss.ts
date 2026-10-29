export function shouldIgnoreTerminalMenuPointerDownOutside(args: {
  openedAtMs: number
  nowMs: number
}): boolean {
  const { openedAtMs, nowMs } = args
  // Ignore only the opening gesture; later right-click/control-click must dismiss normally.
  return nowMs - openedAtMs < 100
}
