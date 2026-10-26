import type { AgentType, AgentWorkingMode } from './agent-status-types'
import type { ExecutionHostId } from './execution-host'
import type { RepoIcon } from './repo-icon'
import type { TuiAgent } from './tui-agent'

/** Main renderer owns live state and relays structured-clone-safe snapshots through main to the presentation-only pop-out; no functions/class instances. */

/** Agent lifecycle columns; idle is optional while completed agents remain visible. */
export type DashboardBucket = 'attention' | 'working' | 'done' | 'idle'

/** Column order shared by producer and pop-out so they never drift. */
export const DASHBOARD_BUCKET_ORDER: readonly DashboardBucket[] = [
  'attention',
  'working',
  'done',
  'idle'
]

/** Producer truncation must match validation so oversized names/OSC titles cannot drop cards from the board. */
export const DASHBOARD_MAX_LABEL_LENGTH = 1_024

/** Builder caps launch choices; exceeding validator limits would drop the entire fleet snapshot. */
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
  /** Null when retained/done cards have no live pane; otherwise resolve the live preview PTY. */
  ptyId: string | null
  agentType: AgentType
  bucket: DashboardBucket
  dotState: DashboardCardDotState
  /** Additive discriminator; older pop-outs render this as ordinary working. */
  workingMode?: AgentWorkingMode
  task: string
  lastUserMessage?: string
  lastAgentMessage?: string
  /** Routing target for click-to-focus. leafId is null when unresolved. */
  repoId: string
  worktreeId: string
  tabId: string
  leafId: string | null
  /** Agent pane that spawned this agent, when both are visible. */
  parentPaneKey?: string
  parentWorktreeId?: string
  repoName: string
  worktreeName: string
  /** Optional for preload compatibility with snapshots produced by older hosts. */
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
  startedAt: number
  /** Finish time matches sidebar time-since-finish; active/uncompleted cards fall back to startedAt. */
  finishedAt: number | null
  /** Bucket-entry time sorts newest first; zero means unknown. */
  stateChangedAt: number
  /** Optional on mixed-version snapshots; pop-out requests one refresh when live status becomes stale. */
  statusUpdatedAt?: number
  /** Derive from the app-wide acknowledgment map so sidebar/tab visits and dashboard dialogs mute unseen state together. */
  unseen: boolean
  /** Short summary of the pending question when bucket === 'attention'. */
  askSummary?: string
  /** Resolve conversation names like sidebar rows; omit unusable status-only titles. */
  conversationName?: string
  /** Carry main-renderer-owned host input facts to the pop-out; null when no live PTY exists. */
  terminalInput?: DashboardCardTerminalInput
}

/** Preview input bytes follow the PTY’s execution host, never the client OS (e.g. macOS driving Windows). */
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
  /** Include active map workspaces without cards; optional for older preload producers. */
  workspaces?: DashboardWorkspace[]
  showIdle?: boolean
  /** Store-derived filters keep zero-card projects/statuses selectable; optional for older preloads. */
  filterOptions?: DashboardFilterOptions
  /** Launch choices resolved on each workspace's execution host. */
  launchableAgentsByWorktreeId?: Record<string, TuiAgent[]>
  /** Share repo icons by ID: repeated per-card 400KB data URLs would bloat several snapshots per second. Optional for older pop-outs. */
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

/** Reveal in main; unresolved leafId still activates the workspace as best effort. */
export type DashboardRevealAgentArgs = {
  repoId: string
  worktreeId: string
  executionHostId?: ExecutionHostId
  tabId: string
  leafId: string | null
}
