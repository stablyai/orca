export function runTerminalPaneUserSplit(canSplitPane: boolean, split: () => void): boolean {
  // Why: orchestration owns maintained-grid topology, so every user-facing
  // split path must share one fail-closed policy while runtime appends remain allowed.
  if (!canSplitPane) {
    return false
  }
  split()
  return true
}
