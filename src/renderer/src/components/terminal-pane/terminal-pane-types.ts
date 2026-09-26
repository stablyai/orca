export type TerminalPaneProps = {
  tabId: string
  worktreeId: string
  cwd?: string
  isActive: boolean
  isVisible?: boolean
  isWorktreeActive?: boolean
  // Activity portals can isolate one split without changing expanded state or persistence.
  isolatedPaneKey?: string | null
  // Why: one-off command terminals keep split shortcuts but hide the prominent header button.
  showSplitButton?: boolean
  onPtyExit: (ptyId: string, exitCode?: number) => void
  onCloseTab: () => void
}

export type TerminalPaneHandle = {
  closeActivePane: () => void
}
