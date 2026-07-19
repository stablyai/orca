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
  /** Raw JSON envelope of an AskUserQuestion / permission request, when the
   *  pane is currently waiting on user input. Same shape as
   *  AgentStatusEntry.interactivePrompt. The pill renderer parses this into
   *  either an AskPrompt (`{ questions: [...] }`) or an approval envelope
   *  (`{ approval: { tool, summary } }`). Undefined when no question is
   *  pending. */
  interactivePrompt?: string
}

export type StatusPillPendingQuestion = {
  /** Pane the question belongs to. Required so the renderer can scope UI
   *  interactions and the answer IPC knows where to write. */
  paneKey: string
  /** Terminal handle that main resolves via runtime.getAgentStatusTerminalHandleForPaneKey.
   *  Cached here so the answer IPC does not need to call into runtime again
   *  from the pill webContents (it is already known when the summary is
   *  computed alongside the row). */
  terminalHandle?: string
  /** Display label for the agent that asked ("Claude", "Codex", …). */
  agentLabel: string
  /** Raw JSON envelope — see StatusPillAgentRow.interactivePrompt. */
  interactivePrompt: string
  /** Tool name associated with the prompt (e.g. "AskUserQuestion", "Edit",
   *  "Bash"). Used by the parser to dispatch question vs approval. */
  toolName?: string
  /** Tab id of the pane, used to focus the main window on this pane after
   *  answering. */
  tabId?: string
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
  /** Set when a pane is currently asking the user a question or requesting
   *  permission. The pill auto-expands and renders a question card. */
  pendingQuestion?: StatusPillPendingQuestion
}

export type StatusPillPreferences = {
  shouldUseDarkColors: boolean
  prefersReducedMotion: boolean
}

export type StatusPillAnswerResult = {
  /** True when the answer bytes reached a live PTY (local or remote). */
  accepted: boolean
  /** Set when accepted is false and main knows why (e.g. pane gone, terminal
   *  not writable). Renderer surfaces it as a transient error. */
  error?: 'pane_not_found' | 'terminal_not_writable' | 'send_failed'
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
  /** Send raw bytes (option number, label text, Escape, …) to the agent PTY
   *  that asked the currently-pending question. Returns whether the write
   *  reached a live terminal. Main resolves the paneKey → terminal handle →
   *  runtime.sendTerminal path, so the pill renderer never needs ptyId. */
  answerQuestion: (paneKey: string, raw: string) => Promise<StatusPillAnswerResult>
}
