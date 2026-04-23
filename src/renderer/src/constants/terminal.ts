export const TOGGLE_TERMINAL_PANE_EXPAND_EVENT = 'orca-toggle-terminal-pane-expand'
export const FOCUS_TERMINAL_PANE_EVENT = 'orca-focus-terminal-pane'
export const SPLIT_TERMINAL_PANE_EVENT = 'orca-split-terminal-pane'
export const CLOSE_TERMINAL_PANE_EVENT = 'orca-close-terminal-pane'

export type ToggleTerminalPaneExpandDetail = {
  tabId: string
}

export type FocusTerminalPaneDetail = {
  tabId: string
  paneId: number
}

export type SplitTerminalPaneDetail = {
  tabId: string
  paneRuntimeId: number
  direction: 'horizontal' | 'vertical'
  command?: string
}

export type CloseTerminalPaneDetail = {
  tabId: string
  paneRuntimeId: number
}
