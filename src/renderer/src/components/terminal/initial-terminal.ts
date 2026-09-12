export function shouldAutoCreateInitialTerminal(
  renderableTabCount: number,
  hasPersistedTerminalState = false
): boolean {
  // Why: a missing row means never initialized; an explicit empty row records that the user closed the last terminal.
  return renderableTabCount === 0 && !hasPersistedTerminalState
}
