/* eslint-disable max-lines */

// ─── Repo ────────────────────────────────────────────────────────────
export type Repo = {
  id: string
  path: string
  displayName: string
  badgeColor: string
  addedAt: number
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

// ─── Terminal Tab ────────────────────────────────────────────────────
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
}

export type WorkspaceSessionState = {
  activeRepoId: string | null
  activeWorktreeId: string | null
  activeTabId: string | null
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
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

export type IssueInfo = {
  number: number
  title: string
  state: IssueState
  url: string
  labels: string[]
}

// ─── Hooks (orca.yaml) ──────────────────────────────────────────────
export type OrcaHooks = {
  scripts: {
    setup?: string // Runs after worktree is created
    archive?: string // Runs before worktree is archived
  }
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
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking'; userInitiated?: boolean }
  | {
      state: 'available'
      version: string
      releaseUrl?: string
      manualDownloadUrl?: string
    }
  | { state: 'not-available'; userInitiated?: boolean }
  | { state: 'downloading'; percent: number; version: string }
  | { state: 'downloaded'; version: string; releaseUrl?: string }
  | { state: 'error'; message: string; userInitiated?: boolean }

// ─── Settings ────────────────────────────────────────────────────────
export type GlobalSettings = {
  workspaceDir: string
  nestWorkspaces: boolean
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
  terminalScrollbackBytes: number
  rightSidebarOpenByDefault: boolean
}

export type WorktreeCardProperty = 'status' | 'unread' | 'ci' | 'issue' | 'pr' | 'comment'

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
  worktreeCardProperties: WorktreeCardProperty[]
  dismissedUpdateVersion: string | null
  lastUpdateCheckAt: number | null
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
