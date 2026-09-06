export type TerminalPaneProps = {
  tabId: string
  worktreeId: string
  cwd?: string
  isActive: boolean
  isVisible?: boolean
  isWorktreeActive?: boolean
  // Activity portals can isolate one split without changing expanded state or persistence.
  isolatedPaneKey?: string | null
  /** Present only while mail background-mounts an unmounted split tab. */
  coldRestorePaneKeys?: ReadonlySet<string>
  // Why: one-off command terminals keep split shortcuts but hide the prominent header button.
  showSplitButton?: boolean
  onPtyExit: (ptyId: string, exitCode?: number) => void
  onCloseTab: () => void
}

export type TerminalPaneHandle = {
  closeActivePane: () => void
}
