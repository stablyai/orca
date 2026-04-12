/* eslint-disable max-lines */

// ─── Repo ────────────────────────────────────────────────────────────
export type RepoKind = 'git' | 'folder'

export type Repo = {
  id: string
  path: string
  displayName: string
  badgeColor: string
  addedAt: number
  kind?: RepoKind
  gitUsername?: string
  worktreeBaseRef?: string
  hookSettings?: RepoHookSettings
}

export type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'
export type SetupDecision = 'inherit' | 'run' | 'skip'

// ─── Worktree (git-level) ────────────────────────────────────────────
export type GitWorktreeInfo = {
  path: string
  head: string
  branch: string
  isBare: boolean
  /** True for the repo's main working tree (the first entry from `git worktree list`).
   *  Linked worktrees created via `git worktree add` have this set to false. */
  isMainWorktree: boolean
}

// ─── Worktree (app-level, enriched) ──────────────────────────────────
export type Worktree = {
  id: string // `${repoId}::${path}`
  repoId: string
  displayName: string
  comment: string
  linkedIssue: number | null
  linkedPR: number | null
  isArchived: boolean
  isUnread: boolean
  sortOrder: number
  lastActivityAt: number
} & GitWorktreeInfo

// ─── Worktree metadata (persisted user-authored fields only) ─────────
export type WorktreeMeta = {
  displayName: string
  comment: string
  linkedIssue: number | null
  linkedPR: number | null
  isArchived: boolean
  isUnread: boolean
  sortOrder: number
  lastActivityAt: number
}

// ─── Unified Tab ────────────────────────────────────────────────────
export type TabContentType = 'terminal' | 'editor' | 'diff' | 'conflict-review' | 'browser'

export type WorkspaceVisibleTabType = 'terminal' | 'editor' | 'browser'

export type Tab = {
  id: string // UUID for terminals, filePath for editors (preserves current convention)
  groupId: string
  worktreeId: string
  contentType: TabContentType
  label: string // display title (auto-derived from PTY or filename)
  customLabel: string | null
  color: string | null
  sortOrder: number
  createdAt: number
  isPreview?: boolean // preview tabs get replaced by next single-click open
  isPinned?: boolean // pinned tabs survive "close others"
}

export type TabGroup = {
  id: string
  worktreeId: string
  activeTabId: string | null
  tabOrder: string[] // canonical visual order of tab IDs
}

// ─── Terminal Tab (legacy — used by persistence and TerminalContentSlice) ─
export type TerminalTab = {
  id: string
  ptyId: string | null
  worktreeId: string
  title: string
  customTitle: string | null
  color: string | null
  sortOrder: number
  createdAt: number
  /** Bumped on shutdown so TerminalPane remounts with a fresh PTY. */
  generation?: number
}

export type BrowserLoadError = {
  code: number
  description: string
  validatedUrl: string
}

export type BrowserTab = {
  id: string
  worktreeId: string
  url: string
  title: string
  loading: boolean
  faviconUrl: string | null
  canGoBack: boolean
  canGoForward: boolean
  loadError: BrowserLoadError | null
  createdAt: number
}

export type TerminalPaneSplitDirection = 'vertical' | 'horizontal'

export type TerminalPaneLayoutNode =
  | {
      type: 'leaf'
      leafId: string
    }
  | {
      type: 'split'
      direction: TerminalPaneSplitDirection
      first: TerminalPaneLayoutNode
      second: TerminalPaneLayoutNode
      /** Flex ratio of the first child (0–1). Defaults to 0.5 if absent. */
      ratio?: number
    }

export type TerminalLayoutSnapshot = {
  root: TerminalPaneLayoutNode | null
  activeLeafId: string | null
  expandedLeafId: string | null
  /** Serialized terminal buffers per leaf for scrollback restoration on restart. */
  buffersByLeafId?: Record<string, string>
  /** User-assigned pane titles, keyed by leafId (e.g. "pane:3").
   *  Persisted alongside buffers via the existing session:set flow. */
  titlesByLeafId?: Record<string, string>
}

/** Minimal subset of OpenFile persisted across restarts.
 *  Only edit-mode files are saved — diffs, conflict reviews, and other
 *  transient views are reconstructed on demand from git state. */
export type PersistedOpenFile = {
  filePath: string
  relativePath: string
  worktreeId: string
  language: string
  isPreview?: boolean
}

export type WorkspaceSessionState = {
  activeRepoId: string | null
  activeWorktreeId: string | null
  activeTabId: string | null
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  /** Worktree IDs that had at least one tab with a live PTY at shutdown.
   *  Used on startup to eagerly re-spawn PTY processes so the Active filter
   *  works immediately after restart. */
  activeWorktreeIdsOnShutdown?: string[]
  /** Editor files that were open at shutdown, keyed by worktree ID.
   *  Only edit-mode files are persisted — diffs and conflict views are
   *  transient and not restored. */
  openFilesByWorktree?: Record<string, PersistedOpenFile[]>
  /** Per-worktree active editor file ID (filePath) at shutdown. */
  activeFileIdByWorktree?: Record<string, string | null>
  /** Persisted browser tabs, keyed by worktree ID. */
  browserTabsByWorktree?: Record<string, BrowserTab[]>
  /** Per-worktree active browser tab ID at shutdown. */
  activeBrowserTabIdByWorktree?: Record<string, string | null>
  /** Per-worktree active tab type (terminal vs editor vs browser) at shutdown. */
  activeTabTypeByWorktree?: Record<string, WorkspaceVisibleTabType>
  /** Per-worktree last-active terminal tab ID at shutdown. */
  activeTabIdByWorktree?: Record<string, string | null>
  /** Unified tab model — present when saved by a build that includes TabsSlice.
   *  Read-path checks for this first; falls back to legacy fields if absent. */
  unifiedTabs?: Record<string, Tab[]>
  /** Tab group model — present alongside unifiedTabs. */
  tabGroups?: Record<string, TabGroup[]>
}

// ─── GitHub ──────────────────────────────────────────────────────────
export type PRState = 'open' | 'closed' | 'merged' | 'draft'
export type IssueState = 'open' | 'closed'
export type CheckStatus = 'pending' | 'success' | 'failure' | 'neutral'

export type PRMergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

export type PRConflictSummary = {
  baseRef: string
  baseCommit: string
  commitsBehind: number
  files: string[]
}

export type PRInfo = {
  number: number
  title: string
  state: PRState
  url: string
  checksStatus: CheckStatus
  updatedAt: string
  mergeable: PRMergeableState
  // Why: check-runs are keyed by the PR head commit, not the mutable branch name.
  // Keeping the head SHA in cached PR metadata lets the checks panel poll the
  // correct commit without re-querying GitHub or guessing from local branch refs.
  headSha?: string
  conflictSummary?: PRConflictSummary
}

export type PRCheckDetail = {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'timed_out'
    | 'neutral'
    | 'skipped'
    | 'pending'
    | null
  url: string | null
}

export type PRComment = {
  id: number
  author: string
  authorAvatarUrl: string
  body: string
  createdAt: string
  url: string
  /** File path for inline review comments (absent for top-level conversation comments). */
  path?: string
  /** GraphQL node ID of the review thread — present only for inline review comments.
   *  Used to resolve/unresolve the thread via GitHub's GraphQL API. */
  threadId?: string
  /** Whether the review thread has been resolved. Only meaningful when threadId is set. */
  isResolved?: boolean
  /** End line of the review annotation (1-based). */
  line?: number
  /** Start line of the review annotation range (1-based). Absent for single-line comments. */
  startLine?: number
}

export type IssueInfo = {
  number: number
  title: string
  state: IssueState
  url: string
  labels: string[]
}

export type GitHubViewer = {
  login: string
  email: string | null
}

// ─── Hooks (orca.yaml) ──────────────────────────────────────────────
export type OrcaHooks = {
  scripts: {
    setup?: string // Runs after worktree is created
    archive?: string // Runs before worktree is archived
  }
  issueCommand?: string // Shared default command for linked GitHub issues
}

export type RepoHookSettings = {
  // Why: legacy persisted data may still include the old UI-hook fields. Orca no longer
  // treats them as an active config surface, but we keep them in the stored shape so
  // existing local state can still be read without migrations.
  mode: 'auto' | 'override'
  setupRunPolicy?: SetupRunPolicy
  scripts: {
    setup: string
    archive: string
  }
}

export type WorktreeSetupLaunch = {
  runnerScriptPath: string
  envVars: Record<string, string>
}

export type CreateWorktreeArgs = {
  repoId: string
  name: string
  baseBranch?: string
  setupDecision?: SetupDecision
}

export type CreateWorktreeResult = {
  worktree: Worktree
  setup?: WorktreeSetupLaunch
}

// ─── Updater ─────────────────────────────────────────────────────────

// Why: the release object sent to the renderer omits `version` (redundant
// with the top-level UpdateStatus.version) to keep one source of truth.
export type ChangelogRelease = {
  title: string
  description: string
  mediaUrl?: string
  releaseNotesUrl: string
}

export type ChangelogData = {
  release: ChangelogRelease
  releasesBehind: number | null
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking'; userInitiated?: boolean }
  | {
      state: 'available'
      version: string
      // Why: releaseUrl is not currently populated by the update-available handler
      // (it always sends undefined). Kept on the type for the Settings page's
      // release-notes link fallback and for potential future use if the main
      // process starts extracting release URLs from electron-updater metadata.
      releaseUrl?: string
      // Why: changelog is always explicitly set by the main process — null means
      // the fetch failed or the version wasn't in the JSON (simple mode), and a
      // populated object means rich mode. Using `| null` (not `?`) avoids a
      // three-state ambiguity (undefined vs null vs present) and makes exhaustive
      // checks straightforward.
      changelog: ChangelogData | null
    }
  | { state: 'not-available'; userInitiated?: boolean }
  | { state: 'downloading'; percent: number; version: string }
  | { state: 'downloaded'; version: string; releaseUrl?: string }
  | { state: 'error'; message: string; userInitiated?: boolean }

// ─── Settings ────────────────────────────────────────────────────────
export type NotificationSettings = {
  enabled: boolean
  agentTaskComplete: boolean
  terminalBell: boolean
  suppressWhenFocused: boolean
}

export type CodexManagedAccount = {
  id: string
  email: string
  managedHomePath: string
  providerAccountId?: string | null
  workspaceLabel?: string | null
  workspaceAccountId?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

export type CodexManagedAccountSummary = {
  id: string
  email: string
  providerAccountId?: string | null
  workspaceLabel?: string | null
  workspaceAccountId?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

export type CodexRateLimitAccountsState = {
  accounts: CodexManagedAccountSummary[]
  activeAccountId: string | null
}

export type GlobalSettings = {
  workspaceDir: string
  nestWorkspaces: boolean
  refreshLocalBaseRefOnWorktreeCreate: boolean
  branchPrefix: 'git-username' | 'custom' | 'none'
  branchPrefixCustom: string
  theme: 'system' | 'dark' | 'light'
  editorAutoSave: boolean
  editorAutoSaveDelayMs: number
  terminalFontSize: number
  terminalFontFamily: string
  terminalFontWeight: number
  terminalCursorStyle: 'bar' | 'block' | 'underline'
  terminalCursorBlink: boolean
  terminalThemeDark: string
  terminalDividerColorDark: string
  terminalUseSeparateLightTheme: boolean
  terminalThemeLight: string
  terminalDividerColorLight: string
  terminalInactivePaneOpacity: number
  terminalActivePaneOpacity: number
  terminalPaneOpacityTransitionMs: number
  terminalDividerThicknessPx: number
  terminalFocusFollowsMouse: boolean
  terminalScrollbackBytes: number
  /** Why: opening arbitrary links inside Orca uses an isolated guest browser surface.
   *  The setting stays opt-in so existing workflows continue to use the system browser
   *  until the user explicitly wants worktree-scoped in-app browsing. */
  openLinksInApp: boolean
  rightSidebarOpenByDefault: boolean
  /** Whether to show the live agent activity count badge in the titlebar. */
  showTitlebarAgentActivity: boolean
  diffDefaultView: 'inline' | 'side-by-side'
  notifications: NotificationSettings
  /** When true, a countdown timer is shown after a Claude agent becomes idle,
   *  indicating time remaining before the prompt cache expires. Disabled by default. */
  promptCacheTimerEnabled: boolean
  /** Prompt-cache TTL in milliseconds. Only two values are supported:
   *  300 000 (5 min, the standard Anthropic API / Bedrock TTL) and
   *  3 600 000 (1 hr, for extended-TTL plans). */
  promptCacheTtlMs: number
  /** Why: Codex rate-limit account routing is a durable app preference owned by
   *  the main process, not transient UI state. Persisting the selected managed
   *  homes here lets Orca resolve the correct `CODEX_HOME` before the renderer
   *  hydrates, while keeping this scope explicitly separate from Codex usage
   *  analytics and external terminal sessions. */
  codexManagedAccounts: CodexManagedAccount[]
  activeCodexManagedAccountId: string | null
}

export type NotificationEventSource = 'agent-task-complete' | 'terminal-bell' | 'test'

export type NotificationDispatchRequest = {
  source: NotificationEventSource
  worktreeId?: string
  repoLabel?: string
  worktreeLabel?: string
  terminalTitle?: string
  isActiveWorktree?: boolean
}

export type NotificationDispatchResult = {
  delivered: boolean
  /** Present when delivered is false. Tells the caller why delivery was skipped. */
  reason?: 'disabled' | 'source-disabled' | 'suppressed-focus' | 'cooldown' | 'not-supported'
}

export type WorktreeCardProperty = 'status' | 'unread' | 'ci' | 'issue' | 'pr' | 'comment'

export type StatusBarItem = 'claude' | 'codex'

export type PersistedUIState = {
  lastActiveRepoId: string | null
  lastActiveWorktreeId: string | null
  sidebarWidth: number
  rightSidebarWidth: number
  groupBy: 'none' | 'repo' | 'pr-status'
  sortBy: 'name' | 'recent' | 'repo'
  showActiveOnly: boolean
  filterRepoIds: string[]
  uiZoomLevel: number
  editorFontZoomLevel: number
  worktreeCardProperties: WorktreeCardProperty[]
  statusBarItems: StatusBarItem[]
  statusBarVisible: boolean
  dismissedUpdateVersion: string | null
  lastUpdateCheckAt: number | null
  /** Whether Orca has already attempted to trigger the macOS notification
   *  permission dialog via a startup notification. Prevents re-firing on
   *  every launch. */
  notificationPermissionRequested?: boolean
  /** Once the user has seen the "your sessions won't be interrupted"
   *  reassurance card, we never show it again. */
  updateReassuranceSeen?: boolean
}

// ─── Persistence shape ──────────────────────────────────────────────
export type PersistedState = {
  schemaVersion: number
  repos: Repo[]
  worktreeMeta: Record<string, WorktreeMeta>
  settings: GlobalSettings
  ui: PersistedUIState
  githubCache: {
    pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
    issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
  }
  workspaceSession: WorkspaceSessionState
}

// ─── Filesystem ─────────────────────────────────────────────
export type DirEntry = {
  name: string
  isDirectory: boolean
  isSymlink: boolean
}

// ─── Filesystem watcher ─────────────────────────────────────
export type FsChangeEvent = {
  kind: 'create' | 'update' | 'delete' | 'rename' | 'overflow'
  absolutePath: string
  oldAbsolutePath?: string
  isDirectory?: boolean
}

export type FsChangedPayload = {
  worktreePath: string
  events: FsChangeEvent[]
}

// ─── Git Status ─────────────────────────────────────────────
export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'copied'
export type GitStagingArea = 'staged' | 'unstaged' | 'untracked'
export type GitConflictKind =
  | 'both_modified'
  | 'both_added'
  | 'both_deleted'
  | 'added_by_us'
  | 'added_by_them'
  | 'deleted_by_us'
  | 'deleted_by_them'

export type GitConflictResolutionStatus = 'unresolved' | 'resolved_locally'
export type GitConflictStatusSource = 'git' | 'session'
export type GitConflictOperation = 'merge' | 'rebase' | 'cherry-pick' | 'unknown'

// Compatibility note for non-upgraded consumers:
// Any consumer that has not been upgraded to read `conflictStatus` may still
// render `modified` styling via the `status` field (which is a compatibility
// fallback, not a semantic claim). However, such consumers must NOT offer
// file-existence-dependent affordances (diff loading, drag payloads, editable-
// file opening) for entries where `conflictStatus === 'unresolved'` — the file
// may not exist on disk (e.g. both_deleted). This affects file explorer
// decorations, tab badges, and any surface outside Source Control.
//
// `conflictStatusSource` is never set by the main process. The renderer stamps
// 'git' for live u-records and 'session' for Resolved locally state.
export type GitUncommittedEntry = {
  path: string
  status: GitFileStatus
  area: GitStagingArea
  oldPath?: string
  conflictKind?: GitConflictKind
  conflictStatus?: GitConflictResolutionStatus
  conflictStatusSource?: GitConflictStatusSource
}

export type GitStatusEntry = GitUncommittedEntry

export type GitStatusResult = {
  entries: GitStatusEntry[]
  conflictOperation: GitConflictOperation
}

export type GitBranchChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied'

export type GitBranchChangeEntry = {
  path: string
  status: GitBranchChangeStatus
  oldPath?: string
}

export type GitBranchCompareSummary = {
  baseRef: string
  baseOid: string | null
  compareRef: string
  headOid: string | null
  mergeBase: string | null
  changedFiles: number
  commitsAhead?: number
  status: 'ready' | 'invalid-base' | 'unborn-head' | 'no-merge-base' | 'loading' | 'error'
  errorMessage?: string
}

export type GitBranchCompareResult = {
  summary: GitBranchCompareSummary
  entries: GitBranchChangeEntry[]
}

export type GitDiffTextResult = {
  kind: 'text'
  originalContent: string
  modifiedContent: string
  originalIsBinary: false
  modifiedIsBinary: false
}

export type GitDiffBinaryResult = {
  kind: 'binary'
  originalContent: string
  modifiedContent: string
  /** Legacy flag used by the renderer for any binary format it can preview, including PDFs. */
  isImage?: boolean
  /** MIME type for binary preview rendering, e.g. "image/png" or "application/pdf" */
  mimeType?: string
} & (
  | { originalIsBinary: true; modifiedIsBinary: boolean }
  | { originalIsBinary: boolean; modifiedIsBinary: true }
)

export type GitDiffResult = GitDiffTextResult | GitDiffBinaryResult

// ─── Search ─────────────────────────────────────────────
export type SearchMatch = {
  line: number
  column: number
  matchLength: number
  lineContent: string
}

export type SearchFileResult = {
  filePath: string
  relativePath: string
  matches: SearchMatch[]
}

export type SearchResult = {
  files: SearchFileResult[]
  totalMatches: number
  truncated: boolean
}

export type SearchOptions = {
  query: string
  rootPath: string
  caseSensitive?: boolean
  wholeWord?: boolean
  useRegex?: boolean
  includePattern?: string
  excludePattern?: string
  maxResults?: number
}

// ─── Stats ──────────────────────────────────────────────────────────

export type StatsSummary = {
  totalAgentsSpawned: number
  totalPRsCreated: number
  totalAgentTimeMs: number
  // For display formatting — sourced from aggregates, not the event log,
  // so it survives event trimming.
  firstEventAt: number | null // timestamp of first-ever event, for "tracking since..."
}
