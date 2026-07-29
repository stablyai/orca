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
  /** Structured worktree id (e.g. "repoId::worktreePath"). Used by
   *  click-to-focus to switch the main window to the pane's worktree. May be
   *  null for sessions without a worktree binding. */
  worktreeId?: string | null
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

// Why: kept in the shared module so both the main-process summary builder
// and the renderer import the same instance, avoiding drift in the empty
// state shape (CodeRabbit nitpick: avoid duplicated constants across the
// sandbox boundary).
export const EMPTY_STATUS_PILL_SUMMARY: StatusPillSummary = {
  working: 0,
  blocked: 0,
  waiting: 0,
  recentDone: 0,
  hasAnyActivity: false,
  activityLabel: '',
  activityPaneKey: null,
  activePaneKey: null,
  activeTabId: null
}

// Why: shared well-known-agent label map so main (`formatAgentType` for the
// activity label) and renderer (`formatAgentLabel` for the avatar row) never
// drift. Keys are lowercased agentType values; values are display labels.
export const STATUS_PILL_AGENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  openclaude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'Copilot',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  aider: 'Aider',
  droid: 'Droid',
  amp: 'Amp',
  grok: 'Grok'
}

/** Resolve a display label for an agent type, falling back to the raw type
 *  when the agent is not in the well-known map (custom / user-defined agent). */
export function formatStatusPillAgentLabel(agentType: string): string {
  // Why: STATUS_PILL_AGENT_LABELS is a plain object, so a custom agent type
  // named "__proto__" or "constructor" would resolve an inherited property
  // instead of falling back to the raw agentType. Guard with hasOwnProperty.
  const key = agentType.toLowerCase()
  return Object.prototype.hasOwnProperty.call(STATUS_PILL_AGENT_LABELS, key)
    ? (STATUS_PILL_AGENT_LABELS[key] as string)
    : agentType
}

export type StatusPillFocusTarget = {
  /** Stable pane key of the agent terminal to focus. */
  paneKey: string
  /** Worktree the pane lives in, so the main window can switch to it before
   *  focusing the terminal leaf. Optional — sessions without a worktree
   *  binding still focus the pane within the active worktree. */
  worktreeId?: string | null
}

export type StatusPillPreloadApi = {
  /** Subscribe to compact summary pushes from the main-process broadcaster.
   *  Returns an unsubscribe. */
  onSnapshot: (callback: (summary: StatusPillSummary) => void) => () => void
  /** Subscribe to full agent-row pushes (used by the expanded multi-agent
   *  panel). Returns an unsubscribe. */
  onAgentRows: (callback: (rows: StatusPillAgentRow[]) => void) => () => void
  /** Subscribe to one-shot attention pokes main fires when an agent newly
   *  asks a question (so the pill can run a stronger bounce animation even if
   *  the user is in another app). Returns an unsubscribe. */
  onAttentionPulse: (callback: () => void) => () => void
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
  /** Focus the exact agent terminal pane the user clicked in the expanded
   *  panel. Main reopens/focuses the main window, switches to the pane's
   *  worktree, and focuses the terminal leaf — mirroring the notification
   *  click path. */
  focusPane: (target: StatusPillFocusTarget) => void
  /** Resolve the initial theme + reduced-motion preferences for first paint. */
  getInitialPreferences: () => Promise<StatusPillPreferences>
  /** Read the pill window's current screen origin. The renderer uses it as the
   *  anchor point when the user starts dragging the pill. */
  getWindowPosition: () => Promise<{ x: number; y: number }>
  /** Move the pill window to a screen origin. Called on each pointermove
   *  during a drag; main debounces the persisted write. */
  setWindowPosition: (position: { x: number; y: number }) => void
  /** Ask main to resize the pill BrowserWindow so the renderer content (which
   *  just expanded/collapsed) fits without clipping. Main keeps the window
   *  centered on the same display. */
  resize: (width: number, height: number) => void
  /** Send raw bytes (option number, label text, Escape, …) to the agent PTY
   *  that asked the currently-pending question. Returns whether the write
   *  reached a live terminal. Main resolves the paneKey → terminal handle →
   *  runtime.sendTerminal path, so the pill renderer never needs ptyId. */
  answerQuestion: (paneKey: string, raw: string) => Promise<StatusPillAnswerResult>
}
