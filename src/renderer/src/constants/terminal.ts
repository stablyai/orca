import type { TerminalPaneSplitSource } from '../../../shared/feature-education-telemetry'

export const TOGGLE_TERMINAL_PANE_EXPAND_EVENT = 'orca-toggle-terminal-pane-expand'
export const FOCUS_TERMINAL_PANE_EVENT = 'orca-focus-terminal-pane'
export const PASTE_TERMINAL_TEXT_EVENT = 'orca-paste-terminal-text'
export const SPLIT_TERMINAL_PANE_EVENT = 'orca-split-terminal-pane'
export const REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT = 'orca-request-active-terminal-pane-split'
export const CLOSE_TERMINAL_PANE_EVENT = 'orca-close-terminal-pane'
export const SET_TERMINAL_PANE_TITLE_EVENT = 'orca-set-terminal-pane-title'
export const REQUEST_ACTIVE_TERMINAL_PANE_CLOSE_EVENT = 'orca-request-active-terminal-pane-close'
export const BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT = 'orca-background-mount-terminal-worktree'

// Mobile wake must fan out by worktree to mounted hidden panes, whose instance-owned bindings can resume without a desktop reveal.
export const WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT = 'orca-wake-hibernated-agents-worktree'

// Fit synchronous sidebar toggles before paint to avoid a wrong-width frame; continuous drags use per-pane ResizeObserver instead.
export const SYNC_FIT_PANES_EVENT = 'orca-sync-fit-panes'

export type FocusTerminalPaneDetail = {
  tabId: string
  /** Use durable layout leaf UUIDs for cross-component focus; renderer-local PaneManager IDs change on replay/reload. */
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
  paneId?: number
  text: string
}

export type SplitTerminalPaneDetail = {
  tabId: string
  worktreeId?: string
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

/** Unlike a split request, a close always names its tab: an untargeted close must not reach every mounted pane. */
export type RequestActiveTerminalPaneCloseDetail = {
  tabId: string
}

export type CloseTerminalPaneDetail = {
  tabId: string
  paneRuntimeId?: number
  leafId?: string
  preservePty?: boolean
  retireSurface?: boolean
  expectedPtyId?: string
}

export type SetTerminalPaneTitleDetail = {
  tabId: string
  /** Durable layout key; the mounted pane resolves it to its renderer-local numeric id. */
  leafId: string
  /** Trimmed title, or null to fall back to the pane's automatic title. */
  title: string | null
}

export type BackgroundMountTerminalWorktreeDetail = {
  worktreeId: string
  /** Target background mounts to exact tabs to avoid connecting every saved pane; omitted IDs preserve legacy whole-worktree mount, lifted by real activation. */
  tabIds?: readonly string[]
}

export type WakeHibernatedAgentsWorktreeDetail = {
  worktreeId: string
  /** Collect provider-session claims from panes consuming/latching wake so generic resume cannot launch those sessions twice. */
  wokenClaimKeys?: Set<string>
}
