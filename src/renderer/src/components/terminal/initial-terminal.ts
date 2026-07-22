export function shouldAutoCreateInitialTerminal(
  renderableTabCount: number,
  automaticCreationEnabled = true
): boolean {
  // Why: the tab-group model is the source of truth; the preference only gates
  // the empty-workspace fallback, never explicit terminal creation.
  return automaticCreationEnabled && renderableTabCount === 0
}
