/* eslint-disable max-lines -- Why: shared type definitions for all runtime RPC methods live in one file for discoverability and import simplicity. */
import type {
  BrowserCookieImportResult,
  BrowserSessionProfile,
  BrowserSessionProfileSource,
  GitWorktreeInfo,
  Repo,
  Worktree,
  WorktreeLineage,
  WorktreeLineageWarning
} from './types'
import type { TerminalPaneLayoutNode } from './types'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult
} from './mobile-markdown-document'
import type { RuntimeCapability } from './protocol-version'

export type { RuntimeMarkdownReadTabResult, RuntimeMarkdownSaveTabResult }

export type RuntimeGraphStatus = 'ready' | 'reloading' | 'unavailable'

// Why: presence-lock driver state crosses main/preload/renderer IPC. Keep one
// checked source so future variants cannot drift silently across layers.
export type RuntimeTerminalDriverState =
  | { kind: 'idle' }
  | { kind: 'desktop' }
  | { kind: 'mobile'; clientId: string }

export type RuntimeStatus = {
  runtimeId: string
  rendererGraphEpoch: number
  graphStatus: RuntimeGraphStatus
  authoritativeWindowId: number | null
  liveTabCount: number
  liveLeafCount: number
  // Why: optional so clients can read both new and pre-contract runtimes.
  // Absence is treated as protocol 0 by the compat evaluator.
  runtimeProtocolVersion?: number
  minCompatibleRuntimeClientVersion?: number
  capabilities?: RuntimeCapability[]
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
  mobileSessionTabs?: RuntimeMobileSessionTabsSnapshot[]
}

export type RuntimeMobileSessionTerminalTab = {
  type: 'terminal'
  id: string
  title: string
  parentTabId: string
  leafId: string
  isActive: boolean
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
}

export type RuntimeMobileSessionFileTab = {
  type: 'file'
  id: string
  title: string
  filePath: string
  relativePath: string
  language: string
  isDirty: boolean
  isActive: boolean
}

export type RuntimeMobileSessionSnapshotTab =
  | RuntimeMobileSessionTerminalTab
  | RuntimeMobileSessionMarkdownTab
  | RuntimeMobileSessionFileTab

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

export type RuntimeMobileSessionTabsSnapshot = {
  worktree: string
  publicationEpoch: string
  snapshotVersion: number
  activeGroupId: string | null
  activeTabId: string | null
  activeTabType: 'terminal' | 'markdown' | 'file' | null
  tabs: RuntimeMobileSessionSnapshotTab[]
}

export type RuntimeMobileSessionTabsResult = {
  worktree: string
  publicationEpoch: string
  snapshotVersion: number
  activeGroupId: string | null
  activeTabId: string | null
  activeTabType: 'terminal' | 'markdown' | 'file' | null
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
  kind: 'markdown' | 'text' | 'binary'
  opened: boolean
}

export type RuntimeFileReadResult = {
  worktree: string
  relativePath: string
  content: string
  truncated: boolean
  byteLength: number
}

export type RuntimeFilePreviewResult = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
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
  surface?: 'background' | 'visible'
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
  parentWorktreeId: string | null
  childWorktreeIds: string[]
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

export type RuntimeWorktreeRecord = Worktree & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
  git: GitWorktreeInfo
}

export type RuntimeWorktreeCreateResult = {
  worktree: RuntimeWorktreeRecord
  lineage: WorktreeLineage | null
  warnings: WorktreeLineageWarning[]
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
  | 'browser_stale_ref'
  | 'browser_ref_not_found'
  | 'browser_navigation_failed'
  | 'browser_element_not_interactable'
  | 'browser_eval_error'
  | 'browser_cdp_error'
  | 'browser_debugger_detached'
  | 'browser_timeout'
  | 'browser_error'

// Computer-use types (see docs/computer-use/plan.md §4 and §12.6).

export const COMPUTER_ERROR_CODES = {
  app_not_found: 'app_not_found',
  app_blocked: 'app_blocked',
  window_not_found: 'window_not_found',
  window_stale: 'window_stale',
  provider_incompatible: 'provider_incompatible',
  unsupported_capability: 'unsupported_capability',
  permission_denied: 'permission_denied',
  element_not_found: 'element_not_found',
  element_not_clickable: 'element_not_clickable',
  action_not_supported: 'action_not_supported',
  value_not_settable: 'value_not_settable',
  invalid_argument: 'invalid_argument',
  action_timeout: 'action_timeout',
  screenshot_failed: 'screenshot_failed',
  accessibility_error: 'accessibility_error'
} as const

export type ComputerErrorCode = keyof typeof COMPUTER_ERROR_CODES

export type ComputerAppQuery = string

export type ComputerSessionTarget = {
  session?: string
  worktree?: string
  app?: ComputerAppQuery
}

export type ComputerListAppsArgs = {
  worktree?: string
}

export type ComputerAppInfo = {
  name: string
  bundleId: string | null
  pid: number
}

export type ComputerWindowInfo = {
  id?: number | null
  title: string
  x?: number | null
  y?: number | null
  width: number
  height: number
  isMinimized?: boolean | null
  isOffscreen?: boolean | null
  screenIndex?: number | null
  platform?: Record<string, unknown>
}

export type ComputerSnapshotData = {
  id: string
  app: ComputerAppInfo
  window: ComputerWindowInfo
  coordinateSpace: 'window'
  treeText: string
  elementCount: number
  focusedElementId: number | null
  truncation?: {
    truncated: boolean
    maxNodes?: number
    maxDepth?: number
    maxDepthReached?: boolean
  }
}

export type ComputerScreenshotData = {
  data?: string
  format: 'png'
  width: number
  height: number
  scale: number
  path?: string
  dataOmitted?: boolean
  expiresAt?: string
}

export type ComputerScreenshotMetadata = {
  engine?: 'screenCaptureKit' | 'cgWindowList' | 'unknown'
  windowId?: number | null
}

export type ComputerScreenshotStatus =
  | { state: 'captured'; metadata?: ComputerScreenshotMetadata }
  | { state: 'skipped'; reason: 'no_screenshot_flag' }
  | {
      state: 'failed'
      code: ComputerErrorCode
      message: string
      metadata?: ComputerScreenshotMetadata
    }

export type ComputerActionMetadata = {
  path: 'accessibility' | 'synthetic' | 'clipboard'
  actionName?: string | null
  fallbackReason?: string | null
  targetWindowId?: number | null
  verification?: ComputerActionVerification
}

export type ComputerActionVerification =
  | {
      state: 'verified'
      property: 'focusedText' | 'selection'
      expected?: string | null
      actualPreview?: string | null
    }
  | {
      state: 'unverified'
      reason: 'synthetic_input' | 'clipboard_paste' | 'provider_unavailable' | 'window_changed'
    }

export type ComputerSnapshotResult = {
  snapshot: ComputerSnapshotData
  screenshot: ComputerScreenshotData | null
  screenshotStatus: ComputerScreenshotStatus
}

export type ComputerActionResult = ComputerSnapshotResult & {
  action?: ComputerActionMetadata
}

export type ComputerProviderCapabilities = {
  platform: NodeJS.Platform
  provider: string
  providerVersion: string
  protocolVersion: number
  supports: {
    apps: {
      list: boolean
      bundleIds: boolean
      pids: boolean
    }
    windows: {
      list: boolean
      targetById: boolean
      targetByIndex: boolean
      focus: boolean
      moveResize: boolean
    }
    observation: {
      screenshot: boolean
      annotatedScreenshot: boolean
      elementFrames: boolean
      ocr: boolean
    }
    actions: {
      click: boolean
      typeText: boolean
      pressKey: boolean
      hotkey: boolean
      pasteText: boolean
      scroll: boolean
      drag: boolean
      setValue: boolean
      performAction: boolean
    }
    surfaces: {
      menus: boolean
      dialogs: boolean
      dock: boolean
      menubar: boolean
    }
  }
}

export type ComputerWindowListWindow = ComputerWindowInfo & {
  app: ComputerAppInfo
  index: number
  isMain?: boolean | null
}

export type ComputerListWindowsResult = {
  app: ComputerAppInfo
  windows: ComputerWindowListWindow[]
}

export type ComputerListAppsResult = {
  apps: (ComputerAppInfo & {
    isRunning: boolean
    lastUsedAt: string | null
    useCount: number | null
  })[]
}
