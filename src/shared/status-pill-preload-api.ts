import type { AgentStatusIpcPayload } from './agent-status-types'

// Why: this type is shared between the dedicated status-pill preload
// (`src/preload/status-pill.ts`) and the pill renderer. Keeping it in a
// shared location under src/shared lets both the main/preload (node)
// tsconfig and the renderer (web) tsconfig see it without importing across
// the electron sandbox boundary.

export type StatusPillAgentRow = {
  paneKey: string
  agentType: string
  state: AgentStatusIpcPayload['state']
  prompt: string
  toolName: string
  terminalName: string | null
  worktreeLabel: string | null
  receivedAt: number
  tabId: string | null
}

export type StatusPillSummary = {
  /** Number of panes currently in each live state, excluding stale `done`. */
  working: number
  blocked: number
  waiting: number
  /** `done` panes that landed inside the stale window. */
  recentDone: number
  /** True when there is at least one non-stale pane of any state. */
  hasAnyActivity: boolean
  /** Single-line description of the most recent active pane. Empty when none. */
  activityLabel: string
  /** paneKey of the pane that activityLabel was derived from. Used by the
   *  renderer to dedupe renders. */
  activityPaneKey: string | null
  /** "Most recently active" pane snapshot — picked so click-to-focus can
   *  target the pane the user most likely wants to jump back to. */
  activePaneKey: string | null
  activeTabId: string | null
}

export type StatusPillPreferences = {
  shouldUseDarkColors: boolean
  prefersReducedMotion: boolean
}

export type StatusPillPreloadApi = {
  /** Subscribe to compact summary pushes from the main-process broadcaster.
   *  Returns an unsubscribe. */
  onSnapshot: (callback: (summary: StatusPillSummary) => void) => () => void
  /** Subscribe to full agent-row pushes (used by the expanded multi-agent
   *  panel). Returns an unsubscribe. */
  onAgentRows: (callback: (rows: StatusPillAgentRow[]) => void) => () => void
  /** Pull the current summary on initial mount before the first push arrives. */
  getSnapshot: () => Promise<StatusPillSummary>
  /** Pull the current agent rows for the expanded panel first paint. */
  getAgentRows: () => Promise<StatusPillAgentRow[]>
  /** Notify main that the user clicked the pill body. Main will focus the
   *  Orca main window (reopening it if needed) and forward the active pane
   *  to the main window renderer for focusTerminalTabSurface. */
  fireClick: () => void
  /** Notify main that the user opened the context menu (right-click). */
  fireContextMenu: () => void
  /** Resolve the initial theme + reduced-motion preferences for first paint. */
  getInitialPreferences: () => Promise<StatusPillPreferences>
}
