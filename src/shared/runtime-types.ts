/* eslint-disable max-lines -- Why: shared type definitions for all runtime RPC methods live in one file for discoverability and import simplicity. */
import type { TerminalPaneLayoutNode } from './types'
import type { BrowserSessionProfile, GitWorktreeInfo, Repo } from './types'

export type RuntimeGraphStatus = 'ready' | 'reloading' | 'unavailable'

export type RuntimeStatus = {
  runtimeId: string
  rendererGraphEpoch: number
  graphStatus: RuntimeGraphStatus
  authoritativeWindowId: number | null
  liveTabCount: number
  liveLeafCount: number
  // Why: optional so mobile builds can read both new and pre-PR desktops.
  // Absence is treated as 0 by mobile's compat evaluator. See
  // src/shared/protocol-version.ts for bump discipline.
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
  }
  runtime: {
    state: CliRuntimeState
    reachable: boolean
    runtimeId: string | null
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
}

export type RuntimeTerminalSummary = {
  handle: string
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

export type RuntimeTerminalListResult = {
  terminals: RuntimeTerminalSummary[]
  totalCount: number
  truncated: boolean
}

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
  nextCursor: string | null
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
}

export type RuntimeTerminalCreate = {
  handle: string
  worktreeId: string
  title: string | null
}

export type RuntimeTerminalSplit = {
  handle: string
  tabId: string
  paneRuntimeId: number
}

export type RuntimeTerminalFocus = {
  handle: string
  tabId: string
  worktreeId: string
}

export type RuntimeTerminalClose = {
  handle: string
  tabId: string
  ptyKilled: boolean
}

export type RuntimeTerminalWaitCondition = 'exit' | 'tui-idle'

export type RuntimeTerminalWait = {
  handle: string
  condition: RuntimeTerminalWaitCondition
  satisfied: boolean
  status: RuntimeTerminalState
  exitCode: number | null
}

export type RuntimeWorktreePsSummary = {
  worktreeId: string
  repoId: string
  repo: string
  path: string
  branch: string
  displayName: string
  linkedIssue: number | null
  linkedPR: { number: number; state: string } | null
  isPinned: boolean
  unread: boolean
  liveTerminalCount: number
  hasAttachedPty: boolean
  lastOutputAt: number | null
  preview: string
  status: RuntimeWorktreeStatus
}

export type RuntimeWorktreeStatus = 'active' | 'working' | 'permission' | 'done' | 'inactive'

export type RuntimeWorktreeRecord = {
  id: string
  repoId: string
  path: string
  branch: string
  linkedIssue: number | null
  git: GitWorktreeInfo
  displayName: string
  comment: string
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
  | 'browser_stale_ref'
  | 'browser_ref_not_found'
  | 'browser_navigation_failed'
  | 'browser_element_not_interactable'
  | 'browser_eval_error'
  | 'browser_cdp_error'
  | 'browser_debugger_detached'
  | 'browser_timeout'
  | 'browser_error'
