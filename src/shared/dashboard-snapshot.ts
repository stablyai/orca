import type { AgentType, AgentWorkingMode } from './agent-status-types'
import type { ExecutionHostId } from './execution-host'
import type { RepoIcon } from './repo-icon'
import type { TuiAgent } from './tui-agent'

/**
 * Serializable contract for the pop-out agent dashboard. The main renderer owns
 * the live store, derives this snapshot, and relays it (through the main
 * process) to the separate pop-out renderer, which renders it presentationally.
 * Every field must be structured-clone-safe (no functions / class instances).
 */

/** Agent lifecycle columns; idle is optional while completed agents remain visible. */
export type DashboardBucket = 'attention' | 'working' | 'done' | 'idle'

/** Column order shared by producer and pop-out so they never drift. */
export const DASHBOARD_BUCKET_ORDER: readonly DashboardBucket[] = [
  'attention',
  'working',
  'done',
  'idle'
]

/** Max length of a card's display labels. The producer truncates to this and
 *  the main-process validator enforces it, so an unbounded name (a long
 *  `terminal rename`, an OSC title) cannot cost the card its place on the board. */
export const DASHBOARD_MAX_LABEL_LENGTH = 1_024

/** The validator drops a whole snapshot that exceeds this, so the builder caps
 *  the launcher's entries rather than letting a huge fleet blank the pop-out. */
export const DASHBOARD_MAX_LAUNCH_WORKTREES = 500

/** Keeps optional map-only workspace metadata bounded across the renderer bridge. */
export const DASHBOARD_MAX_MAP_WORKSPACES = 2_000

/** Kept distinct from `bucket` so attention cards retain their precise dot state. */
export type DashboardCardDotState = 'working' | 'blocked' | 'waiting' | 'done' | 'idle'
export type DashboardCardDisplayState = DashboardCardDotState | 'monitoring'

/** Completed agents stay green until acknowledged, then settle into gray idle. */
export function dashboardCardDisplayState(
  card: Pick<DashboardCard, 'dotState' | 'workingMode' | 'unseen'>
): DashboardCardDisplayState {
  if (card.dotState === 'working' && card.workingMode === 'monitoring') {
    return 'monitoring'
  }
  return card.dotState === 'done' && !card.unseen ? 'idle' : card.dotState
}

export type DashboardCardReview = {
  number: number
  state: 'open' | 'closed' | 'merged' | 'draft'
}

export type DashboardCardSubagent = {
  id: string
  name: string
  dotState: DashboardCardDotState
}

export type DashboardCardHostKind = 'local' | 'ssh' | 'wsl' | 'remote'
export type DashboardCardWorkspaceKind = 'worktree' | 'folder'

export type DashboardWorkspace = {
  repoId: string
  worktreeId: string
  repoName: string
  worktreeName: string
  parentWorktreeId?: string
  hostKind: DashboardCardHostKind
  executionHostId: ExecutionHostId
  /** Friendly saved-host name for compact host tooltips. */
  hostLabel?: string
  workspaceKind: DashboardCardWorkspaceKind
  workspaceStatusId?: string
  workspaceStatusLabel?: string
  workspaceStatusColor?: string
  hasReview?: boolean
  review?: DashboardCardReview
}

export type DashboardCard = {
  /** Stable identity for React keys. */
  paneKey: string
  /** Resolved live PTY id for the terminal preview, or null when the agent has
   *  no live pane (e.g. a retained/done row whose pane is gone). */
  ptyId: string | null
  agentType: AgentType
  bucket: DashboardBucket
  dotState: DashboardCardDotState
  /** Additive discriminator; older pop-outs render this as ordinary working. */
  workingMode?: AgentWorkingMode
  /** One-line task/prompt text shown on the card. */
  task: string
  /** The most recent message the user sent this agent (its current prompt). */
  lastUserMessage?: string
  /** The most recent message the agent sent back. */
  lastAgentMessage?: string
  /** Routing target for click-to-focus. leafId is null when unresolved. */
  repoId: string
  worktreeId: string
  tabId: string
  leafId: string | null
  /** Agent pane that spawned this agent, when both are visible. */
  parentPaneKey?: string
  /** Direct workspace parent. The map uses it only when both workspace rings are visible. */
  parentWorktreeId?: string
  repoName: string
  worktreeName: string
  /** Optional for preload compatibility with snapshots produced before Agent Map. */
  hostKind?: DashboardCardHostKind
  /** Exact owner used by in-window workspace actions when IDs collide across hosts. */
  executionHostId?: ExecutionHostId
  /** Friendly saved-host name for compact host tooltips. */
  hostLabel?: string
  /** Folder workspaces share the ring hierarchy without pretending to be git worktrees. */
  workspaceKind?: DashboardCardWorkspaceKind
  workspaceStatusId?: string
  workspaceStatusLabel?: string
  workspaceStatusColor?: string
  /** True when the workspace links a review whose live state is not cached yet. */
  hasReview?: boolean
  review?: DashboardCardReview
  subagents?: DashboardCardSubagent[]
  /** "Started … ago" display. */
  startedAt: number
  /** When the agent last entered `done`, or null if it never finished. Drives
   *  the card's time column: finished cards read time-since-finish (parity with
   *  the left worktree sidebar), active cards fall back to startedAt. */
  finishedAt: number | null
  /** When the agent entered its current state — column ordering key (cards
   *  that moved into a bucket most recently sort first). 0 when unknown. */
  stateChangedAt: number
  /** Last accepted hook update. Optional for mixed-version snapshots; the
   *  pop-out uses it to request one refresh when a live state becomes stale. */
  statusUpdatedAt?: number
  /** Mirrors the sidebar's unvisited signal: the agent changed state since the
   *  user last acknowledged it (visited its tab / opened its dashboard dialog).
   *  Derived from the app-wide ack map so both surfaces mute in lockstep. */
  unseen: boolean
  /** Short summary of the pending question when bucket === 'attention'. */
  askSummary?: string
  /** The tab's conversation name, resolved exactly as the sidebar's agent rows
   *  resolve it. Undefined when no usable name exists (status-only titles). */
  conversationName?: string
  /** Host-dependent input facts the preview terminal needs to encode keys the
   *  way this agent's real pane does. Null when the card has no live pty. Only
   *  the main renderer owns the store these derive from, so they ride the
   *  snapshot to reach the pop-out. */
  terminalInput?: DashboardCardTerminalInput
}

/**
 * Per-pty input contract shared by a pane and its dashboard preview. Byte
 * protocols follow the PTY's execution host, not the client OS — they differ
 * for a macOS client driving a Windows runtime.
 */
export type DashboardCardTerminalInput = {
  /** Platform executing the pty; picks the host-side byte encodings. */
  hostPlatform: NodeJS.Platform
  /** Local native Windows ConPTY, where PSReadLine binds Ctrl+←/→ itself. */
  localWindowsConpty: boolean
  /** OS release of a local Windows client, for xterm's ConPTY wrap-marker compat. */
  osRelease?: string
  /** Shift+Enter encoding resolved from this pane's agent evidence. */
  windowsShiftEnterEncoding: 'alt-enter' | 'csi-u'
  /** Force protected multiline paste when the live agent requires paste frames. */
  forceBracketedMultilineTextPaste?: true
  /** Newline encoding for Windows TUIs that consume console input records. */
  windowsInputRecordPasteNewline?: 'alt-enter' | 'csi-u'
  /** Trusted query-only consumer accepts Ctrl+Enter CSI-u without active flags. */
  ctrlEnterCsiU: boolean
  /** False withholds the kitty (CSI-u) advertisement, as ConPTY panes do. */
  kittyKeyboardAdvertised: boolean
}

export type DashboardFilterOption = {
  id: string
  label: string
  color?: string
}

export type DashboardFilterOptions = {
  projects: DashboardFilterOption[]
  workspaceStatuses: DashboardFilterOption[]
}

export type DashboardSnapshot = {
  generatedAt: number
  cards: DashboardCard[]
  /** Active workspaces, including those without an agent card. Map-only and
   *  optional for preload compatibility with older snapshot producers. */
  workspaces?: DashboardWorkspace[]
  showIdle?: boolean
  /** Available filter dimensions are store-derived so zero-card projects and
   *  statuses remain selectable. Optional for preload-version compatibility. */
  filterOptions?: DashboardFilterOptions
  /** Launch choices resolved on each workspace's execution host. */
  launchableAgentsByWorktreeId?: Record<string, TuiAgent[]>
  /** Icons for the repos the cards belong to. Keyed by repoId rather than
   *  carried per card: image icons are data URLs up to 400KB, and the snapshot
   *  is republished several times a second. Optional so a pop-out running
   *  pre-upgrade code still accepts the payload. */
  repoIconsByRepoId?: Record<string, RepoIcon | null>
}

export const EMPTY_DASHBOARD_SNAPSHOT: DashboardSnapshot = {
  generatedAt: 0,
  cards: [],
  workspaces: [],
  filterOptions: { projects: [], workspaceStatuses: [] },
  launchableAgentsByWorktreeId: {},
  repoIconsByRepoId: {}
}

/** Routing payload for click-to-focus: reveal this agent's pane in the main
 *  window. leafId is null when the pane could not be resolved (best-effort:
 *  the worktree is still activated). */
export type DashboardRevealAgentArgs = {
  repoId: string
  worktreeId: string
  executionHostId?: ExecutionHostId
  tabId: string
  leafId: string | null
}

export type DashboardSpawnAgentArgs = {
  worktreeId: string
  agent: TuiAgent
}

/** Puts a workspace to sleep from the dashboard: the main renderer owns the
 *  teardown sequence, so the pop-out only names the target. */
export type DashboardSleepWorkspaceArgs = {
  worktreeId: string
}

/** Longest printed path the file-link bridge accepts; the main-process
 *  validator enforces it so a pathological TUI line cannot cross the bridge. */
export const DASHBOARD_MAX_FILE_LINK_PATH_LENGTH = 4_096

/** Opens a file path a preview terminal linkified. Resolution against the
 *  workspace, host routing and the editor all live in the main renderer, so the
 *  pop-out only names the workspace and the path exactly as the agent printed
 *  it — the pop-out has no worktree paths and no editor of its own. */
export type DashboardOpenFileArgs = {
  worktreeId: string
  executionHostId?: ExecutionHostId
  path: string
  line: number | null
  column: number | null
  /** Shift+Mod-click hands the file to the OS default app, as a pane does. */
  openWithSystemDefault?: boolean
}
