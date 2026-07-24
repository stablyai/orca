/* eslint-disable max-lines -- Why: shared type definitions for all runtime RPC methods live in one file for discoverability and import simplicity. */
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  AgentStatusState,
  AgentType
} from './agent-status-types'
import type {
  BaseRefSearchResult,
  BrowserCookieImportResult,
  BrowserCertificateFailure,
  BrowserLoadError,
  BrowserSessionProfile,
  BrowserSessionProfileSource,
  CreateWorktreeResult,
  GitWorktreeInfo,
  RemoveWorktreeResult,
  Repo,
  TabGroupLayoutNode,
  TerminalColorOverrides,
  TerminalLayoutSnapshot,
  TuiAgent,
  Worktree,
  WorktreeLineage,
  WorkspaceLineage,
  WorktreeLineageWarning
} from './types'
import type { TerminalPaneLayoutNode } from './types'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult
} from './mobile-markdown-document'
import type { RuntimeCapability } from './protocol-version'
import type { RemoteRuntimeSharedConnectionDiagnostics } from './remote-runtime-shared-control-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from './agent-session-resume'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import type { RemoteServerUpdateSupport } from './remote-server-update'
import type { ExecutionHostId } from './execution-host'
import type { PtyIncarnationId } from './pty-incarnation'

export type { RuntimeMarkdownReadTabResult, RuntimeMarkdownSaveTabResult }

export type RuntimeGraphStatus = 'ready' | 'reloading' | 'unavailable'

export type RuntimeDesktopWindowStatus = 'available' | 'openable' | 'initializing' | 'blocked'

// Why: headless serve still owns one runtime graph, but zero can never collide
// with Electron BrowserWindow ids and can be transferred safely on promotion.
export const HEADLESS_RUNTIME_WINDOW_ID = 0

// Why: the access scope a paired device token grants. Lives in shared so
// pairing offers, status.get, and the device registry use one vocabulary.
export type DeviceScope = 'mobile' | 'runtime'

// Why: presence-lock driver state crosses main/preload/renderer IPC. Keep one
// checked source so future variants cannot drift silently across layers.
export type RuntimeTerminalDriverState =
  | { kind: 'idle' }
  | { kind: 'desktop' }
  | { kind: 'mobile'; clientId: string }

export type RuntimeBrowserDriverState = RuntimeTerminalDriverState

export type RuntimeStatus = {
  runtimeId: string
  rendererGraphEpoch: number
  graphStatus: RuntimeGraphStatus
  authoritativeWindowId: number | null
  desktopWindowStatus?: RuntimeDesktopWindowStatus
  liveTabCount: number
  liveLeafCount: number
  // Why: optional so clients can read both new and pre-contract runtimes.
  // Absence is treated as protocol 0 by the compat evaluator.
  runtimeProtocolVersion?: number
  minCompatibleRuntimeClientVersion?: number
  capabilities?: RuntimeCapability[]
  // Why: optional fields let updated clients inventory both new and legacy paired servers.
  appVersion?: string
  remoteUpdateSupport?: RemoteServerUpdateSupport
  remoteControl?: RemoteRuntimeSharedConnectionDiagnostics | null
  hostPlatform?: NodeJS.Platform
  terminalWindowsShell?: string | null
  // Why: legacy or saved WebSocket pairings may not carry scope metadata, so
  // the server stamps the authenticated token scope here for status.get only.
  deviceScope?: DeviceScope
  // Why: mobile gates its Floating Workspace entry on this; absent on older
  // hosts, false when the user disabled the feature in desktop settings.
  floatingWorkspaceEnabled?: boolean
  // COMPAT(runtimeStatusMobileAliases): added 2026-05-15 for mobile builds
  // that still read these names; new desktop/CLI code uses the fields above.
  protocolVersion?: number
  minCompatibleMobileVersion?: number
}

export type CliRuntimeState =
  | 'not_running'
  | 'starting'
  | 'ready'
  | 'graph_not_ready'
  | 'stale_bootstrap'

export type CliStatusResult = {
  app: {
    running: boolean
    pid: number | null
    desktopWindowStatus?: RuntimeDesktopWindowStatus
  }
  runtime: {
    state: CliRuntimeState
    reachable: boolean
    runtimeId: string | null
    appVersion?: string
    remoteUpdateSupport?: RemoteServerUpdateSupport
    capabilities?: RuntimeCapability[]
  }
  graph: {
    state: RuntimeGraphStatus | 'not_running' | 'starting'
  }
}

export type RuntimeSyncedTab = {
  tabId: string
  worktreeId: string
  title: string | null
  activeLeafId: string | null
  layout: TerminalPaneLayoutNode | null
}

export type RuntimeSyncedLeaf = {
  tabId: string
  worktreeId: string
  leafId: string
  paneRuntimeId: number
  ptyId: string | null
  paneTitle?: string | null
  title?: string | null
}

export type RuntimeSyncWindowGraph = {
  tabs: RuntimeSyncedTab[]
  leaves: RuntimeSyncedLeaf[]
  mobileSessionTabs?: RuntimeMobileSessionTabsSnapshot[]
}

export type RuntimeSyncWindowGraphResult = RuntimeStatus & {
  /** Main owns terminal handles/dispatches, so renderer graph sync returns the
   *  parent metadata needed by title-derived agent rows without name guessing. */
  agentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
}

export type RuntimeMobileSessionTerminalTab = {
  type: 'terminal'
  id: string
  title: string
  quickCommandLabel?: string | null
  parentTabId: string
  leafId: string
  ptyId?: string | null
  terminalTheme?: RuntimeMobileTerminalTheme
  agentStatus?: AgentStatusEntry | null
  launchAgent?: TuiAgent
  startupCwd?: string
  parentLayout?: TerminalLayoutSnapshot
  /** Tab-level color/pin (per parentTabId), host-persisted for remote servers. */
  color?: string | null
  isPinned?: boolean
  /** Per-tab view preference (terminal xterm vs native chat). Host-persisted so
   *  paired clients converge; clients still win during the optimistic echo window. */
  viewMode?: 'terminal' | 'chat'
  isActive: boolean
}

export type RuntimeMobileTerminalTheme = {
  mode: 'dark' | 'light'
  theme: TerminalColorOverrides
}

export type RuntimeMobileSessionMarkdownTab = {
  type: 'markdown'
  id: string
  title: string
  filePath: string
  relativePath: string
  language: 'markdown'
  mode: 'edit' | 'markdown-preview'
  isDirty: boolean
  isActive: boolean
  sourceFileId: string
  sourceFilePath: string
  sourceRelativePath: string
  documentVersion: string
  /** Tab-level color/pin, host-persisted for remote servers. */
  color?: string | null
  isPinned?: boolean
}

export type RuntimeMobileSessionFileTab = {
  type: 'file'
  id: string
  title: string
  filePath: string
  relativePath: string
  language: string
  mode?: 'edit' | 'diff'
  diffSource?: 'staged' | 'unstaged'
  isDirty: boolean
  /** Tab-level color/pin, host-persisted for remote servers. */
  color?: string | null
  isPinned?: boolean
  isActive: boolean
}

export type RuntimeMobileSessionBrowserTab = {
  type: 'browser'
  id: string
  title: string
  browserWorkspaceId: string
  browserPageId: string | null
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  loadError?: BrowserLoadError | null
  certificateFailure?: BrowserCertificateFailure | null
  color?: string | null
  isPinned?: boolean
  isActive: boolean
}

export type RuntimeMobileSessionSnapshotTab =
  | RuntimeMobileSessionTerminalTab
  | RuntimeMobileSessionMarkdownTab
  | RuntimeMobileSessionFileTab
  | RuntimeMobileSessionBrowserTab

export type RuntimeMobileSessionTerminalClientTab =
  | (RuntimeMobileSessionTerminalTab & {
      status: 'pending-handle'
      terminal: null
    })
  | (RuntimeMobileSessionTerminalTab & {
      status: 'ready'
      terminal: string
    })

export type RuntimeMobileSessionClientTab =
  | RuntimeMobileSessionTerminalClientTab
  | RuntimeMobileSessionMarkdownTab
  | RuntimeMobileSessionFileTab
  | RuntimeMobileSessionBrowserTab

export type RuntimeMobileSessionTabGroup = {
  id: string
  activeTabId: string | null
  tabOrder: string[]
  recentTabIds?: string[]
}

type RuntimeMobileSessionTabMoveBase = {
  tabId: string
  targetGroupId: string
}

export type RuntimeMobileSessionTabMove =
  | (RuntimeMobileSessionTabMoveBase & {
      kind: 'reorder'
      tabOrder: string[]
    })
  | (RuntimeMobileSessionTabMoveBase & {
      kind: 'move-to-group'
      index?: number
    })
  | (RuntimeMobileSessionTabMoveBase & {
      kind: 'split'
      splitDirection: 'left' | 'right' | 'up' | 'down'
    })

export type RuntimeMobileSessionTabMoveResult = {
  moved: true
}

export type RuntimeMobileSessionTabCloseResult = {
  closed: true
  refused?: true
  refusalReason?:
    | 'missing-intent'
    | 'stale-publication'
    | 'stale-terminal'
    | 'live-host-pty'
    | 'unknown-liveness'
    | 'retirement-owner'
  // Why: only a republished snapshot can restore a live mirror; dead-leaf refusals intentionally omit this marker.
  snapshotRepublished?: true
}

// Why: lets the host tell a user's close from a client-lifecycle echo
// ('pty-exit'/'cleanup') and adjudicate against its own PTY liveness.
// Absent on legacy clients, where the existing close endpoint remains user intent.
export type RuntimeSessionTabCloseReason = 'user' | 'pty-exit' | 'cleanup'

export type RuntimeMobileSessionTabsSnapshot = {
  worktree: string
  publicationEpoch: string
  snapshotVersion: number
  activeGroupId: string | null
  activeTabId: string | null
  activeTabType: 'terminal' | 'markdown' | 'file' | 'browser' | null
  tabGroups?: RuntimeMobileSessionTabGroup[]
  tabGroupLayout?: TabGroupLayoutNode | null
  tabs: RuntimeMobileSessionSnapshotTab[]
}

export type RuntimeMobileSessionTabsResult = {
  worktree: string
  publicationEpoch: string
  snapshotVersion: number
  /** Live-only targeted command; omitted from durable/list snapshots so reconnect cannot replay navigation. */
  navigationIntent?: 'follow'
  activeGroupId: string | null
  activeTabId: string | null
  activeTabType: 'terminal' | 'markdown' | 'file' | 'browser' | null
  tabGroups?: RuntimeMobileSessionTabGroup[]
  tabGroupLayout?: TabGroupLayoutNode | null
  tabs: RuntimeMobileSessionClientTab[]
}

export type RuntimeMobileSessionCreateTerminalResult = {
  tab: RuntimeMobileSessionTerminalClientTab
  publicationEpoch: string
  snapshotVersion: number
}

export type RuntimeMobileSessionTabsRemovedResult = RuntimeMobileSessionTabsResult & {
  removed: true
  activeGroupId: null
  activeTabId: null
  activeTabType: null
  tabs: []
}

export type RuntimeFileListEntry = {
  relativePath: string
  basename: string
  kind: 'text' | 'binary'
}

export type RuntimeFileListResult = {
  worktree: string
  rootPath: string
  files: RuntimeFileListEntry[]
  totalCount: number
  truncated: boolean
}

export type RuntimeFileOpenResult = {
  worktree: string
  relativePath: string
  kind: 'markdown' | 'text' | 'binary' | 'image'
  opened: boolean
}

export type RuntimeFileReadResult = {
  worktree: string
  relativePath: string
  content: string
  truncated: boolean
  byteLength: number
}

export type RuntimeTerminalPathOpenTarget =
  | {
      kind: 'worktree-file'
      provider: 'local' | 'ssh'
      relativePath: string
      absolutePath: string
    }
  | {
      kind: 'absolute-file'
      provider: 'local' | 'ssh'
      absolutePath: string
      grantId: string
    }
  | {
      kind: 'unsupported'
      reason: string
    }

/** Result of resolving a file path tapped in the mobile terminal against the
 *  worktree root (+ optional cwd). relativePath is null when the path resolves
 *  outside the worktree (not openable via the worktree-scoped file RPCs). */
export type RuntimeTerminalPathResolution = {
  worktree: string
  relativePath: string | null
  /** Absolute on-disk path (or remote path), present when relativePath is.
   *  Used to build a file:// URL for opening HTML in a browser tab. */
  absolutePath: string | null
  exists: boolean
  isDirectory: boolean
  openTarget?: RuntimeTerminalPathOpenTarget
}

export type RuntimeFilePreviewResult = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
}

export type RuntimeFileReadChunkResult = {
  contentBase64: string
  bytesRead: number
  eof: boolean
}

export type RuntimeTerminalSummary = {
  handle: string
  ptyId: string | null
  incarnationId?: string | null
  orphaned?: boolean
  worktreeId: string
  worktreePath: string
  branch: string
  tabId: string
  leafId: string
  title: string | null
  connected: boolean
  writable: boolean
  lastOutputAt: number | null
  preview: string
}

export type RuntimeTerminalVisualTerminalNode = {
  type: 'terminal'
  handle: string
  tabId: string
  leafId: string
  title: string | null
  connected: boolean
  active: boolean
}

export type RuntimeTerminalVisualPaneNode =
  | RuntimeTerminalVisualTerminalNode
  | {
      type: 'pane-split'
      direction: Extract<TerminalPaneLayoutNode, { type: 'split' }>['direction']
      first: RuntimeTerminalVisualPaneNode
      second: RuntimeTerminalVisualPaneNode
    }

export type RuntimeTerminalVisualTab = {
  tabId: string
  title: string | null
  activeLeafId: string | null
  panes: RuntimeTerminalVisualPaneNode
}

export type RuntimeTerminalVisualGroupNode = {
  type: 'group'
  groupId: string | null
  activeTabId: string | null
  tabs: RuntimeTerminalVisualTab[]
}

export type RuntimeTerminalVisualLayoutNode =
  | RuntimeTerminalVisualGroupNode
  | {
      type: 'split'
      direction: Extract<TabGroupLayoutNode, { type: 'split' }>['direction']
      first: RuntimeTerminalVisualLayoutNode
      second: RuntimeTerminalVisualLayoutNode
    }

export type RuntimeTerminalVisualLayout = {
  worktreeId: string
  worktreePath: string
  root: RuntimeTerminalVisualLayoutNode
}

export type RuntimeTerminalListResult = {
  terminals: RuntimeTerminalSummary[]
  visualLayouts?: RuntimeTerminalVisualLayout[]
  topologyRevisions?: Record<string, number>
  totalCount: number
  truncated: boolean
}

export type RuntimeTerminalOrphanAdoptionClaim = {
  terminal: string
  ptyId: string
  incarnationId: PtyIncarnationId
  tabId: string
  leafId: string
}

export type RuntimeTerminalOrphanTopologyTab = {
  tabId: string
  root: TerminalPaneLayoutNode
  activeLeafId: string
  expandedLeafId: string | null
}

export type RuntimeTerminalOrphanTopologyGroup = {
  id: string
  activeTabId: string
  tabOrder: string[]
  recentTabIds?: string[]
}

export type RuntimeTerminalOrphanTopology = {
  tabs: RuntimeTerminalOrphanTopologyTab[]
  groups: RuntimeTerminalOrphanTopologyGroup[]
  groupLayout?: TabGroupLayoutNode
}

export type RuntimeTerminalOrphanAdoptionRequest = {
  worktree: string
  expectedTopologyRevision: number
  claims: RuntimeTerminalOrphanAdoptionClaim[]
  activeTabId?: string
  activeGroupId?: string
  topology?: RuntimeTerminalOrphanTopology
}

export type RuntimeTerminalOrphanAdoptionResult = {
  adopted: boolean
  topologyRevision: number
  snapshot: RuntimeMobileSessionTabsResult
}

export type RuntimeWorktreeTerminalSleepFailure =
  | 'terminal_liveness_unavailable'
  | 'terminal_worktree_sleep_still_live'

export type RuntimeWorktreeTerminalSleepResult = {
  stopped: number
  stoppedPtyIds: string[]
  livePtyIds: string[]
} & (
  | {
      postStopVerified: true
      postStopFailure?: never
      remainingLivePtyIds?: never
    }
  | {
      postStopVerified: false
      postStopFailure: 'terminal_liveness_unavailable'
      remainingLivePtyIds?: never
    }
  | {
      postStopVerified: false
      postStopFailure: 'terminal_worktree_sleep_still_live'
      remainingLivePtyIds: string[]
    }
)

export type RuntimeTerminalShow = RuntimeTerminalSummary & {
  paneRuntimeId: number
  ptyId: string | null
  rendererGraphEpoch: number
}

export type RuntimeTerminalState = 'running' | 'exited' | 'unknown'

export type RuntimeTerminalRead = {
  handle: string
  status: RuntimeTerminalState
  tail: string[]
  truncated: boolean
  limited?: boolean
  oldestCursor?: string
  nextCursor: string | null
  latestCursor?: string
  returnedLineCount?: number
}

export type RuntimeTerminalRename = {
  handle: string
  tabId: string
  title: string | null
}

export type RuntimeTerminalSend = {
  handle: string
  accepted: boolean
  bytesWritten: number
  refusedReason?: 'no-agent' | 'permission'
}

export type RuntimeTerminalAgentStatusState = 'working' | 'permission' | 'idle' | null

export type RuntimeTerminalAgentStatus = {
  handle: string
  isRunningAgent: boolean
  status: RuntimeTerminalAgentStatusState
}

export type RuntimeTerminalPresentation = 'background' | 'focused'
type RuntimeTerminalCreateBaseRequestPayload = {
  requestId: string
  worktreeId?: string
  afterTabId?: string
  targetGroupId?: string
  command?: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  launchToken?: string
  launchAgent?: TuiAgent
  viewMode?: 'terminal' | 'chat'
  startupCommandDelivery?: StartupCommandDelivery
  title?: string
  activate?: boolean
  presentation?: RuntimeTerminalPresentation
}

export type RuntimeTerminalCreateRequestPayload =
  | (RuntimeTerminalCreateBaseRequestPayload & { source?: undefined })
  | (RuntimeTerminalCreateBaseRequestPayload & {
      worktreeId: string
      // Why: only the host-owned runtime-session bridge may bypass the renderer's
      // active-runtime local terminal guard; ordinary UI requests must omit this.
      source: 'runtime-session'
    })

export type RuntimeTerminalCreate = {
  handle: string
  tabId?: string
  paneKey?: string | null
  ptyId?: string | null
  worktreeId: string
  title: string | null
  /** Spawn-time execution identity; paired clients must not infer nested SSH from their own graph. */
  executionHostId?: ExecutionHostId
  hostPlatform?: NodeJS.Platform
  surface?: 'background' | 'visible'
  warning?: string
  /** Present only for the structured host-authority resume path. */
  agentSessionDisposition?: 'created' | 'adopted'
}

export type RuntimeTerminalSplit = {
  handle: string
  tabId: string
  paneRuntimeId: number
}

export type RuntimeTerminalResolvePane = {
  handle: string
  tabId: string
  leafId: string
  ptyId: string | null
  worktreeId?: string
  executionHostId?: ExecutionHostId
  hostPlatform?: NodeJS.Platform
}

export type RuntimeTerminalFocus = {
  handle: string
  tabId: string
  worktreeId: string
}

export type RuntimeTerminalClose = {
  handle: string
  tabId: string
  /** Present for the durable whole-tab lifecycle without changing legacy receipts. */
  closeMode?: 'tab'
  ptyKilled: boolean
}

export type RuntimeTerminalWaitCondition = 'exit' | 'tui-idle'
export type RuntimeTerminalWaitBlockedReason =
  | 'codex-update-prompt'
  | 'codex-trust-workspace'
  | 'codex-cwd-prompt'
  | 'codex-model-migration-prompt'
  | 'codex-hooks-review-prompt'
  | 'codex-interactive-prompt'

export type RuntimeTerminalWait = {
  handle: string
  condition: RuntimeTerminalWaitCondition
  satisfied: boolean
  status: RuntimeTerminalState
  exitCode: number | null
  blockedReason?: RuntimeTerminalWaitBlockedReason
}

/** One agent's live status as carried to mobile in a worktree.ps summary.
 *  Flat shape (parentPaneKey points to another row in the same worktree's list)
 *  so the client can rebuild the spawn-lineage tree desktop renders inline. */
export type RuntimeWorktreeAgentRow = {
  paneKey: string
  /** paneKey of the orchestration parent, or null for a root agent. */
  parentPaneKey: string | null
  state: AgentStatusState
  agentType: AgentType | null
  /** Raw hook-reported prompt. Display surfaces can prefer displayName. */
  prompt: string
  /** Explicit orchestration task title, or null outside dispatch. */
  taskTitle: string | null
  /** Explicit UI label for orchestration task rows, or null outside dispatch. */
  displayName: string | null
  lastAssistantMessage: string | null
  toolName: string | null
  toolInput: string | null
  interrupted: boolean
  /** When the current `state` was first reported (ms). Drives "Xm ago". */
  stateStartedAt: number
  updatedAt: number
}

export type RuntimeWorktreePsSummary = {
  workspaceKind?: 'git' | 'folder-workspace'
  worktreeId: string
  repoId: string
  hostId?: Worktree['hostId']
  terminalPlatform?: NodeJS.Platform
  repo: string
  path: string
  branch: string
  isArchived: boolean
  isMainWorktree: boolean
  hasHostSidebarActivity: boolean
  worktreeInstanceId?: string
  lineageWorktreeInstanceId?: string
  parentWorktreeInstanceId?: string
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  displayName: string
  workspaceStatus: string
  sortOrder: number
  manualOrder?: number
  lastActivityAt?: number
  createdAt?: number
  linkedIssue: number | null
  linkedPR: { number: number; state: string } | null
  linkedLinearIssue: string | null
  linkedGitLabMR: number | null
  linkedGitLabIssue: number | null
  comment: string
  isPinned: boolean
  /** True for the worktree currently focused on the desktop/host
   *  (session.activeWorktreeId). Mobile scrolls it into view and highlights it
   *  so the list reflects the desktop's current selection. */
  isActive: boolean
  unread: boolean
  liveTerminalCount: number
  hasAttachedPty: boolean
  lastOutputAt: number | null
  preview: string
  status: RuntimeWorktreeStatus
  /** Live agents in this worktree, newest-state-first. Empty for shell-only
   *  worktrees. Mirrors desktop's inline agent list (WorktreeCardAgents). */
  agents: RuntimeWorktreeAgentRow[]
}

export type RuntimeGitLocalBranches = {
  current: string | null
  branches: string[]
}

/** One speech model as presented to the mobile dictation-setup sheet: catalog
 *  metadata joined with live download/ready state. */
export type RuntimeSpeechModelSummary = {
  id: string
  label: string
  provider: 'local' | 'openai'
  sizeBytes: number | null
  recommended: boolean
  status: 'ready' | 'not-downloaded' | 'downloading' | 'extracting' | 'error'
  progress: number | null
}

export type RuntimeSpeechSetupState = {
  enabled: boolean
  selectedModelId: string
  /** 'toggle' = press once to start/stop; 'hold' = dictate while held. */
  dictationMode: 'toggle' | 'hold'
  models: RuntimeSpeechModelSummary[]
}

export type RuntimeGitCheckoutResult = {
  ok: true
  branch: string
}

export type RuntimeWorktreeStatus = 'active' | 'working' | 'permission' | 'done' | 'inactive'

export type RuntimeWorktreeRecord = Worktree & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
  git: GitWorktreeInfo
}

export type RuntimeWorktreeCreateResult = {
  worktree: RuntimeWorktreeRecord
  lineage: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
  warnings: WorktreeLineageWarning[]
  warning?: string
  startupTerminal?: CreateWorktreeResult['startupTerminal']
  agentTerminalHandle?: string
}

export type RuntimeWorktreeRemoveResult = RemoveWorktreeResult & {
  removed: boolean
  warning?: string
}

export type RuntimeWorktreePsResult = {
  worktrees: RuntimeWorktreePsSummary[]
  totalCount: number
  truncated: boolean
}

export type RuntimeRepoList = {
  repos: Repo[]
}

export type RuntimeRepoSearchRefs = {
  refs: string[]
  refDetails?: BaseRefSearchResult[]
  truncated: boolean
}

export type RuntimeWorktreeListResult = {
  worktrees: RuntimeWorktreeRecord[]
  totalCount: number
  truncated: boolean
}

// ── Browser automation types ──

export type BrowserSnapshotRef = {
  ref: string
  role: string
  name: string
}

export type BrowserSnapshotResult = {
  browserPageId: string
  snapshot: string
  refs: BrowserSnapshotRef[]
  url: string
  title: string
}

export type BrowserClickResult = {
  clicked: string
}

export type BrowserGotoResult = {
  url: string
  title: string
}

export type BrowserFillResult = {
  filled: string
}

export type BrowserTypeResult = {
  typed: boolean
}

export type BrowserSelectResult = {
  selected: string
}

export type BrowserScrollResult = {
  scrolled: 'up' | 'down'
}

export type BrowserBackResult = {
  url: string
  title: string
}

export type BrowserReloadResult = {
  url: string
  title: string
}

export type BrowserScreenshotResult = {
  data: string
  format: 'png' | 'jpeg'
}

export type BrowserScreencastReadyResult = {
  type: 'ready'
  subscriptionId: string
  browserPageId: string
  format: 'jpeg' | 'png'
  tab: BrowserTabInfo
}

export type BrowserScreencastEndResult = {
  type: 'end'
  subscriptionId: string
}

export type BrowserScreencastDialogResult = {
  type: 'dialog'
  dialogType: string
  message: string
}

export type BrowserScreencastDialogClosedResult = {
  type: 'dialogClosed'
}

export type BrowserScreencastErrorResult = {
  type: 'error'
  message: string
}

export type BrowserScreencastResult =
  | BrowserScreencastReadyResult
  | BrowserScreencastEndResult
  | BrowserScreencastDialogResult
  | BrowserScreencastDialogClosedResult
  | BrowserScreencastErrorResult

export type BrowserEvalResult = {
  result: string
  origin: string
}

export type BrowserTabInfo = {
  browserPageId: string
  index: number
  url: string
  title: string
  active: boolean
  // Why: a failed load leaves getURL() at chrome-error://; surface the structured
  // error so an agent driving the browser can tell a bypassable certificate
  // failure from an ordinary network error the way the UI can.
  loadError?: BrowserLoadError | null
  certificateFailure?: BrowserCertificateFailure | null
  worktreeId?: string | null
  profileId?: string | null
  profileLabel?: string | null
}

export type BrowserTabListResult = {
  tabs: BrowserTabInfo[]
}

export type BrowserTabSwitchResult = {
  switched: number
  browserPageId: string
}

export type BrowserTabSetProfileResult = {
  browserPageId: string
  profileId: string | null
  profileLabel: string | null
}

export type BrowserTabShowResult = {
  tab: BrowserTabInfo
}

export type BrowserTabCurrentResult = {
  tab: BrowserTabInfo
}

export type BrowserTabProfileShowResult = {
  browserPageId: string
  worktreeId: string | null
  profileId: string | null
  profileLabel: string | null
}

export type BrowserTabProfileCloneResult = {
  browserPageId: string
  sourceBrowserPageId: string
  profileId: string | null
  profileLabel: string | null
}

export type BrowserProfileListResult = {
  profiles: BrowserSessionProfile[]
}

export type BrowserProfileCreateResult = {
  profile: BrowserSessionProfile | null
}

export type BrowserProfileDeleteResult = {
  deleted: boolean
  profileId: string
}

export type BrowserDetectedProfileInfo = {
  name: string
  directory: string
}

export type BrowserDetectedInfo = {
  family: BrowserSessionProfileSource['browserFamily']
  label: string
  profiles: BrowserDetectedProfileInfo[]
  selectedProfile: string
}

export type BrowserDetectProfilesResult = {
  browsers: BrowserDetectedInfo[]
}

export type BrowserProfileImportFromBrowserResult = BrowserCookieImportResult

export type BrowserProfileClearDefaultCookiesResult = {
  cleared: boolean
}

export type BrowserHoverResult = {
  hovered: string
}

export type BrowserDragResult = {
  dragged: { from: string; to: string }
}

export type BrowserUploadResult = {
  uploaded: number
}

export type BrowserWaitResult = {
  waited: boolean
}

export type BrowserCheckResult = {
  checked: boolean
}

export type BrowserFocusResult = {
  focused: string
}

export type BrowserClearResult = {
  cleared: string
}

export type BrowserSelectAllResult = {
  selected: string
}

export type BrowserKeypressResult = {
  pressed: string
}

export type BrowserPdfResult = {
  data: string
}

// ── Cookie management types ──

export type BrowserCookie = {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: string
}

export type BrowserCookieGetResult = {
  cookies: BrowserCookie[]
}

export type BrowserCookieSetResult = {
  success: boolean
}

export type BrowserCookieDeleteResult = {
  deleted: boolean
}

// ── Viewport emulation types ──

export type BrowserViewportResult = {
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}

// ── Geolocation types ──

export type BrowserGeolocationResult = {
  latitude: number
  longitude: number
  accuracy: number
}

// ── Request interception types ──

export type BrowserInterceptedRequest = {
  id: string
  url: string
  method: string
  headers: Record<string, string>
  resourceType: string
}

export type BrowserInterceptEnableResult = {
  enabled: boolean
  patterns: string[]
}

export type BrowserInterceptDisableResult = {
  disabled: boolean
}

// ── Console/network capture types ──

export type BrowserConsoleEntry = {
  level: string
  text: string
  timestamp: number
  url?: string
  line?: number
}

export type BrowserConsoleResult = {
  entries: BrowserConsoleEntry[]
  truncated: boolean
}

export type BrowserNetworkEntry = {
  url: string
  method: string
  status: number
  mimeType: string
  size: number
  timestamp: number
}

export type BrowserNetworkLogResult = {
  entries: BrowserNetworkEntry[]
  truncated: boolean
}

export type BrowserCaptureStartResult = {
  capturing: boolean
}

export type BrowserCaptureStopResult = {
  stopped: boolean
}

export type BrowserExecResult = {
  output: unknown
}

export type BrowserTabCreateResult = {
  browserPageId: string
}

export type BrowserTabCloseResult = {
  closed: boolean
}

export type BrowserErrorCode =
  | 'browser_no_tab'
  | 'browser_tab_not_found'
  | 'browser_tab_closed'
  | 'browser_tab_changed'
  | 'browser_owner_unavailable'
  | 'browser_stale_ref'
  | 'browser_ref_not_found'
  | 'browser_navigation_failed'
  | 'browser_element_not_interactable'
  | 'browser_eval_error'
  | 'browser_cdp_error'
  | 'browser_debugger_detached'
  | 'browser_timeout'
  | 'browser_error'

export type EmulatorErrorCode =
  | 'emulator_no_active'
  | 'emulator_device_not_found'
  | 'emulator_helper_failed'
  | 'emulator_not_macos'
  | 'emulator_error'

// Keep the broad runtime-types import surface stable while letting computer-use
// CI watch a narrow contract file instead of every runtime type change.
export * from './computer-use-runtime-types'
