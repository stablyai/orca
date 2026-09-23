/** Decide whether activation should seed a terminal for an otherwise empty workspace. */
export function shouldAutoCreateInitialTerminal(
  renderableTabCount: number,
  hasPersistedTerminalState = false,
  automaticCreationEnabled = true
): boolean {
  // Why: a missing row means never initialized; an explicit empty row records that the user closed the last terminal.
  return automaticCreationEnabled && renderableTabCount === 0 && !hasPersistedTerminalState
}
