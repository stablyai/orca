export function shouldAutoCreateInitialTerminal(
  renderableTabCount: number,
  hasPersistedTerminalState = false
): boolean {
  // Desktop treats empty legacy/non-close rows as uninitialized via isTerminalWorkspaceEmptiedOnPurpose.
  return renderableTabCount === 0 && !hasPersistedTerminalState
}
