/** 'layout' fits the hidden pane at real size; 'warm' also keeps its renderer live. */
export type HiddenTerminalPrewarm = 'layout' | 'warm'

export type TerminalPaneProps = {
  tabId: string
  worktreeId: string
  cwd?: string
  isActive: boolean
  isVisible?: boolean
  isWorktreeActive?: boolean
  /** Lay out while hidden (like a hidden startup) so a likely reveal skips first fit and style. */
  measureWhileHidden?: boolean
  /** Keep WebGL attached in the laid-out hidden host so a likely reveal skips context and atlas setup. */
  warmRendererWhileHidden?: boolean
  // Activity portals can isolate one split without changing expanded state or persistence.
  isolatedPaneKey?: string | null
  // Why: one-off command terminals keep split shortcuts but hide the prominent header button.
  showSplitButton?: boolean
  onPtyExit: (ptyId: string, exitCode?: number) => void
  onCloseTab: () => void
}
