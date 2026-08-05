export type CombinedDiffFileTreeHintChoice = 'shown' | 'hidden'

export type CombinedDiffFileTreeHintChoiceInput = {
  choice: CombinedDiffFileTreeHintChoice
  updateSettings: (settings: { combinedDiffFileTreeVisibleByDefault: boolean }) => unknown
  setFileTreeCollapsed: (collapsed: boolean) => void
  dismissHint: () => void
}

// Answers the hint in place: writes the same setting Settings > Editor writes, and
// only reveals the tree when the user asked to see it.
export function applyCombinedDiffFileTreeHintChoice({
  choice,
  updateSettings,
  setFileTreeCollapsed,
  dismissHint
}: CombinedDiffFileTreeHintChoiceInput): void {
  updateSettings({ combinedDiffFileTreeVisibleByDefault: choice === 'shown' })
  if (choice === 'shown') {
    setFileTreeCollapsed(false)
  }
  // Why "hidden" skips setFileTreeCollapsed: it pins the module-level session
  // override, which would stop later Settings changes from reaching open diff tabs.
  dismissHint()
}
