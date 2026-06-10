import type { TerminalPaneSplitSource } from '../../../shared/feature-education-telemetry'

export const TOGGLE_TERMINAL_PANE_EXPAND_EVENT = 'orca-toggle-terminal-pane-expand'
export const FOCUS_TERMINAL_PANE_EVENT = 'orca-focus-terminal-pane'
export const PASTE_TERMINAL_TEXT_EVENT = 'orca-paste-terminal-text'
export const SPLIT_TERMINAL_PANE_EVENT = 'orca-split-terminal-pane'
export const REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT = 'orca-request-active-terminal-pane-split'
export const CLOSE_TERMINAL_PANE_EVENT = 'orca-close-terminal-pane'
export const BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT = 'orca-background-mount-terminal-worktree'
// Why: surfaces that show/hide terminals with CSS only (floating workspace)
// never flip TerminalPane visibility, so they need an explicit trigger for
// WebGL glyph-atlas recovery when they become visible again.
export const RESET_TERMINAL_WEBGL_ATLAS_EVENT = 'orca-reset-terminal-webgl-atlas'

// Why: sidebar open/close is an instantaneous width change. If we wait for
// the ResizeObserver rAF (and the 150ms debounced global fit) to catch up,
// the user sees the terminal in a wrongly-fit state for ~16ms+ then a snap
// as it reflows. Dispatching this event in a useLayoutEffect lets the
// terminal fit synchronously before paint — so the new width and the
// reflowed terminal land on the same frame with no visible transient.
//
// Continuous drags (sidebar-width drag, tab-group split drag) use the
// per-pane ResizeObserver path instead.
export const SYNC_FIT_PANES_EVENT = 'orca-sync-fit-panes'

export type ToggleTerminalPaneExpandDetail = {
  tabId: string
}

export type FocusTerminalPaneDetail = {
  tabId: string
  /** Stable terminal layout leaf UUID. Numeric PaneManager ids are renderer-local
   *  and can be reminted during replay/reload, so cross-component focus uses
   *  the durable leaf identity and resolves it at the receiving TerminalPane. */
  leafId: string | null
  /** Optional paneKey to ack only after the target leaf resolves and focuses. */
  ackPaneKeyOnSuccess?: string
  /** Briefly lights the resolved pane rim after focus for click-to-locate flows. */
  flashFocusedPane?: boolean
  /** Follow live agent output when activation is explicitly about that agent. */
  scrollToBottomIfOutputSinceLastView?: boolean
}

export type PasteTerminalTextDetail = {
  tabId: string
  text: string
}

export type ResetTerminalWebglAtlasDetail = {
  tabId: string
}

export type SplitTerminalPaneDetail = {
  tabId: string
  paneRuntimeId: number
  direction: 'horizontal' | 'vertical'
  command?: string
  sourceLeafId?: string
  sourcePtyId?: string
  telemetrySource?: TerminalPaneSplitSource
  newLeafId?: string
  ptyId?: string
}

export type RequestActiveTerminalPaneSplitDetail = {
  tabId?: string | null
  direction: 'horizontal' | 'vertical'
}

export type CloseTerminalPaneDetail = {
  tabId: string
  paneRuntimeId: number
}

export type BackgroundMountTerminalWorktreeDetail = {
  worktreeId: string
}
