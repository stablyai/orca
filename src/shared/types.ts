/* eslint-disable max-lines */
import type { SshTarget } from './ssh-types'
import type { WorkspaceSource } from './telemetry-events'
import type { GitHubProjectSettings } from './github-project-types'

// Re-exported for backward compat with renderer call sites that import
// `WorkspaceCreateTelemetrySource` from '../../../shared/types'.
export type { WorkspaceSource as WorkspaceCreateTelemetrySource } from './telemetry-events'

// ─── Repo ────────────────────────────────────────────────────────────
export type RepoKind = 'git' | 'folder'

/**
 * Per-repo user choice for where issues are fetched and filed.
 *
 * Why three states, not two: storage must distinguish "user explicitly chose
 * upstream" from "heuristic happens to resolve to upstream right now." Collapsing
 * the two would let a remote-topology change (someone removes `upstream`, or
 * adds one later) silently move the effective source — the exact silent-source-
 * switch class the upstream-issue-source design rejects.
 *
 * - `'auto'` (or undefined): honor the heuristic in `getIssueOwnerRepo`
 *   (upstream-if-exists, else origin). Initial state for every repo.
 * - `'upstream'`: explicit upstream. Wins over heuristic and future topology
 *   changes. Falls back to origin if `upstream` remote vanishes, with a toast.
 * - `'origin'`: explicit origin. Same precedence.
 */
export type IssueSourcePreference = 'upstream' | 'origin' | 'auto'

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
  /** SSH target ID for remote repos. null/undefined = local. */
  connectionId?: string | null
  /** Per-repo override for issue-source resolution. `undefined` is treated
   *  identically to `'auto'`; writers leave it undefined on creation so
   *  existing persisted records stay forward-compatible. */
  issueSourcePreference?: IssueSourcePreference
  /** Paths (relative to the primary checkout) that should be symlinked into
   *  newly created worktrees of this repo. Consumed only when the global
   *  `experimentalWorktreeSymlinks` flag is on — the per-repo list is the
   *  "what to link", the global flag is the "whether to link at all" switch.
   *  Undefined/empty means no symlinks are created for this repo. */
  symlinkPaths?: string[]
}

export type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'
export type SetupDecision = 'inherit' | 'run' | 'skip'

/**
 * Envelope returned by the `repos:getBaseRefDefault` IPC handler.
 *
 * Why: declared in `shared/` rather than colocated with the handler so the
 * preload bridge and renderer can import the same named type. Before this
 * lived in `src/main/git/repo.ts` — the preload layer cannot import from
 * `src/main/`, which forced three sites to inline the same structural shape
 * and risk silent drift.
 *
 * Why `remoteCount`: BaseRefPicker renders a multi-remote hint when the repo
 * has more than one configured remote; piggybacking the count on this IPC
 * avoids a second round-trip.
 *
 * Why `defaultBaseRef` (not `default`): `default` is a reserved word and is
 * awkward to destructure.
 */
export type BaseRefDefaultResult = {
  defaultBaseRef: string | null
  remoteCount: number
}

// ─── Worktree (git-level) ────────────────────────────────────────────
export type GitWorktreeInfo = {
  path: string
  head: string
  branch: string
  isBare: boolean
  isSparse?: boolean
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
  linkedLinearIssue: string | null
  isArchived: boolean
  isUnread: boolean
  isPinned: boolean
  sortOrder: number
  lastActivityAt: number
  /** Set once when Orca creates the worktree. Absent for worktrees discovered
   *  on disk or persisted before this field existed. Used by the sidebar to
   *  grant newly-created worktrees a short grace window at the top of Recent,
   *  immune to ambient PTY-bump reordering in other worktrees. */
  createdAt?: number
  sparseDirectories?: string[]
  sparseBaseRef?: string
  /** ID of the saved preset this worktree was created from, if any. Cleared
   *  when the worktree is no longer sparse on refresh. */
  sparsePresetId?: string
  /** Intended create base for stale-base probes. Persisted metadata, not UI drift state. */
  baseRef?: string
  diffComments?: DiffComment[]
} & GitWorktreeInfo

// ─── Worktree metadata (persisted user-authored fields only) ─────────
export type WorktreeMeta = {
  displayName: string
  comment: string
  linkedIssue: number | null
  linkedPR: number | null
  linkedLinearIssue: string | null
  isArchived: boolean
  isUnread: boolean
  isPinned: boolean
  sortOrder: number
  lastActivityAt: number
  /** See {@link Worktree.createdAt}. Persisted to orca-data.json. */
  createdAt?: number
  sparseDirectories?: string[]
  sparseBaseRef?: string
  sparsePresetId?: string
  /** Intended create base for stale-base probes. Persisted metadata, not UI drift state. */
  baseRef?: string
  diffComments?: DiffComment[]
}

// ─── Diff line comments ──────────────────────────────────────────────
// Why: users leave review notes on specific lines of the modified side of
// a diff so they can be handed back to an AI agent (pasted into a terminal
// or used to bootstrap a new agent session). Stored on WorktreeMeta so the
// existing persistence layer writes them to orca-data.json automatically.
export type DiffComment = {
  id: string
  worktreeId: string
  filePath: string
  lineNumber: number
  body: string
  createdAt: number
  // Reserved for future "comments on the original side" — always 'modified' in v1.
  side: 'modified'
}

// ─── Tab Group Layout ───────────────────────────────────────────────
export type TabGroupSplitDirection = 'horizontal' | 'vertical'

export type TabGroupLayoutNode =
  | { type: 'leaf'; groupId: string }
  | {
      type: 'split'
      direction: TabGroupSplitDirection
      first: TabGroupLayoutNode
      second: TabGroupLayoutNode
      /** Flex ratio of the first child (0–1). Defaults to 0.5 if absent. */
      ratio?: number
    }

// ─── Unified Tab ────────────────────────────────────────────────────
export type TabContentType = 'terminal' | 'editor' | 'diff' | 'conflict-review' | 'browser'

export type WorkspaceVisibleTabType = 'terminal' | 'editor' | 'browser'

export type Tab = {
  id: string // UUID for terminals, filePath for editors (preserves current convention)
  entityId: string // ID of the backing content (terminal tab ID, file path, browser workspace ID)
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
  /** Per-group MRU stack (oldest → most-recent at the tail). Drives which tab
   *  becomes active when the current active tab closes: we pop back to the
   *  previously-active tab instead of jumping to a visual neighbor. Scoped to
   *  the group so split panes keep independent histories. Optional because
   *  sessions persisted before this field was added still hydrate cleanly —
   *  hydration seeds from activeTabId. */
  recentTabIds?: string[]
}

// ─── Terminal Tab (legacy — used by persistence and TerminalContentSlice) ─
export type TerminalTab = {
  id: string
  ptyId: string | null
  worktreeId: string
  title: string
  /** Stable fallback label for default-named terminals ("Terminal 1", etc.).
   *  Why: agent CLIs overwrite the live title via OSC updates, but Orca still
   *  needs the original terminal label for numbering and reset behavior. */
  defaultTitle?: string
  customTitle: string | null
  color: string | null
  sortOrder: number
  createdAt: number
  /** Bumped on shutdown so TerminalPane remounts with a fresh PTY. */
  generation?: number
  /** Why: records the shell this tab was explicitly opened with (e.g. 'wsl.exe'
   *  from the "+" submenu) so the PTY can re-use the same shell on reconnect
   *  without needing the user to interact with the tab again. Undefined means
   *  "use the default shell setting". */
  shellOverride?: string
  /** Why: when `setActiveWorktree` bumps generation on all-dead tabs to drive a
   *  TerminalPane remount, the fresh PTY that results is caused by navigation,
   *  not by the user doing work. Without this flag the resulting
   *  `updateTabPtyId` call would call `bumpWorktreeActivity` and flip the
   *  sidebar's recency sort on every click — the reorder-on-click bug. The
   *  flag is set by `setActiveWorktree` and consumed (cleared) by the first
   *  `updateTabPtyId` that follows, which then suppresses the activity bump
   *  and the `sortEpoch` increment. Never persisted — it is a transient
   *  handoff between the two calls. */
  pendingActivationSpawn?: boolean
}

export type BrowserHistoryEntry = {
  url: string
  normalizedUrl: string
  title: string
  lastVisitedAt: number
  visitCount: number
}

export type BrowserLoadError = {
  code: number
  description: string
  validatedUrl: string
}

// Why: BrowserPage persists the active viewport preset so CDP emulation can be
// reapplied on reload/navigation without the user re-picking from the toolbar.
export type BrowserViewportPresetId =
  | 'mobile-s'
  | 'mobile-m'
  | 'mobile-l'
  | 'tablet'
  | 'laptop'
  | 'laptop-l'
  | 'desktop'

export type BrowserViewportOverride = {
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}

export type BrowserPage = {
  id: string
  workspaceId: string
  worktreeId: string
  url: string
  title: string
  loading: boolean
  faviconUrl: string | null
  canGoBack: boolean
  canGoForward: boolean
  loadError: BrowserLoadError | null
  createdAt: number
  /** Active CDP viewport emulation preset. null = default (fill pane, no CDP override) */
  viewportPresetId?: BrowserViewportPresetId | null
}

export type BrowserWorkspace = {
  id: string
  worktreeId: string
  /** Stable display label for the outer Orca tab ("Browser 1", "Browser 2", …).
   *  Optional so sessions persisted before this field was added fall back
   *  gracefully to the URL-derived label in getBrowserTabLabel. */
  label?: string
  // Why: each browser workspace binds to exactly one session profile at creation
  // time. The profile determines which Electron partition (and thus which
  // cookies/storage) the guest webview uses. Absent means the legacy shared
  // partition, which keeps backward compat with workspaces persisted before
  // session profiles existed.
  sessionProfileId?: string | null
  activePageId?: string | null
  pageIds?: string[]
  // Why: the active page owns real browser chrome state now, but the top-level
  // Orca tab strip still renders one workspace entry. Mirror the active page's
  // title/url/loading metadata here so existing workspace-level UI can stay
  // stable while Phase 2 introduces nested browser pages.
  url: string
  title: string
  loading: boolean
  faviconUrl: string | null
  canGoBack: boolean
  canGoForward: boolean
  loadError: BrowserLoadError | null
  createdAt: number
}

export type BrowserTab = BrowserWorkspace

export type BrowserSessionProfileScope = 'default' | 'isolated' | 'imported'

export type BrowserSessionProfileSource = {
  browserFamily: 'chrome' | 'chromium' | 'arc' | 'edge' | 'firefox' | 'safari' | 'manual'
  profileName?: string
  importedAt: number
}

export type BrowserSessionProfile = {
  id: string
  scope: BrowserSessionProfileScope
  partition: string
  label: string
  source: BrowserSessionProfileSource | null
}

export type BrowserCookieImportSummary = {
  totalCookies: number
  importedCookies: number
  skippedCookies: number
  domains: string[]
}

export type BrowserCookieImportResult =
  | { ok: true; profileId: string; summary: BrowserCookieImportSummary }
  | { ok: false; reason: string }

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
  /** Live PTY IDs per leaf for in-session remounts such as tab-group moves.
   *  Not used for app restart because PTYs are transient processes. */
  ptyIdsByLeafId?: Record<string, string>
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
  /** Persisted browser workspaces, keyed by worktree ID. */
  browserTabsByWorktree?: Record<string, BrowserWorkspace[]>
  /** Persisted browser pages, keyed by workspace ID. */
  browserPagesByWorkspace?: Record<string, BrowserPage[]>
  /** Per-worktree active browser workspace ID at shutdown. */
  activeBrowserTabIdByWorktree?: Record<string, string | null>
  /** Per-worktree active tab type (terminal vs editor vs browser) at shutdown. */
  activeTabTypeByWorktree?: Record<string, WorkspaceVisibleTabType>
  /** Global browser URL history for address bar autocomplete. */
  browserUrlHistory?: BrowserHistoryEntry[]
  /** Per-worktree last-active terminal tab ID at shutdown. */
  activeTabIdByWorktree?: Record<string, string | null>
  /** Unified tab model — present when saved by a build that includes TabsSlice.
   *  Read-path checks for this first; falls back to legacy fields if absent. */
  unifiedTabs?: Record<string, Tab[]>
  /** Tab group model — present alongside unifiedTabs. */
  tabGroups?: Record<string, TabGroup[]>
  /** Persisted split layout tree per worktree. */
  tabGroupLayouts?: Record<string, TabGroupLayoutNode>
  /** Per-worktree focused group at shutdown. */
  activeGroupIdByWorktree?: Record<string, string>
  /** SSH target IDs that were connected at shutdown. Used on startup to
   *  auto-reconnect before attempting remote PTY reattach. */
  activeConnectionIdsAtShutdown?: string[]
  /** Maps tab IDs to their remote relay PTY session IDs. Populated at
   *  shutdown from renderer state so remote PTYs can be reattached via
   *  the relay's pty.attach RPC on startup. */
  remoteSessionIdsByTabId?: Record<string, string>
  /** Per-worktree focus-recency timestamps used by the Cmd+J empty-query
   *  ordering. Separate from worktree.lastActivityAt (background signal)
   *  and worktreeNavHistory (Back/Forward stack). See
   *  docs/cmd-j-empty-query-ordering.md. Absent in sessions written by
   *  older builds — hydration tolerates missing/partial maps and the
   *  active worktree is seeded on first restore. */
  lastVisitedAtByWorktreeId?: Record<string, number>
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

export type GitHubReactionContent =
  | '+1'
  | '-1'
  | 'laugh'
  | 'confused'
  | 'heart'
  | 'hooray'
  | 'rocket'
  | 'eyes'

export type GitHubReaction = {
  content: GitHubReactionContent
  count: number
}

export type PRComment = {
  id: number
  author: string
  authorAvatarUrl: string
  body: string
  createdAt: string
  url: string
  reactions?: GitHubReaction[]
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
  /** True when GitHub identifies the author as a bot (REST `user.type === 'Bot'` or
   *  GraphQL `__typename === 'Bot'`). Preferred over login-string heuristics because
   *  third-party review bots (e.g. qodo-ai-reviewer, coderabbitai) don't follow a
   *  predictable naming convention. Absent when the data source can't report it
   *  (non-GitHub fallbacks via `gh pr view`). */
  isBot?: boolean
}

export type GitHubCommentResult = { ok: true; comment: PRComment } | { ok: false; error: string }

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

export type GitHubAssignableUser = {
  login: string
  name: string | null
  avatarUrl: string
}

export type GitHubWorkItem = {
  id: string
  type: 'issue' | 'pr'
  number: number
  title: string
  state: 'open' | 'closed' | 'merged' | 'draft'
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  branchName?: string
  baseRefName?: string
  // Why: true when a PR's head lives on a fork (headRepositoryOwner !== selected repo owner).
  // The Start-from picker disables fork PRs in v1 because the create flow cannot
  // safely resolve a fork head from headRefName alone.
  isCrossRepository?: boolean
  /** Why: required because the cross-repo view merges items from every selected
   *  repo — the table row's repo pill and the "open in browser" fallback need
   *  to know which repo an item came from. Stamped by the renderer fetcher
   *  (`fetchWorkItems`) and by optimistic stubs on the new-issue path. */
  repoId: string
}

export type GitHubPRFile = {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions: number
  deletions: number
  /** GitHub marks files above its diff size limit as binary-like; we skip content fetches for these. */
  isBinary: boolean
}

export type GitHubPRFileContents = {
  original: string
  modified: string
  originalIsBinary: boolean
  modifiedIsBinary: boolean
}

export type GitHubPRReviewCommentInput = {
  repoPath: string
  prNumber: number
  commitId: string
  path: string
  line: number
  startLine?: number
  body: string
}

export type GitHubWorkItemDetails = {
  // Why: main-process doesn't know Orca's Repo.id, so this inner item omits
  // repoId. The renderer stamps it when routing the details through the store.
  item: Omit<GitHubWorkItem, 'repoId'>
  body: string
  comments: PRComment[]
  /** Only set for PRs. Head/base SHAs used by the Files tab to fetch per-file content. */
  headSha?: string
  baseSha?: string
  checks?: PRCheckDetail[]
  files?: GitHubPRFile[]
  participants?: GitHubAssignableUser[]
  /** Logins of current assignees. Only set for issues. */
  assignees?: string[]
}

// ─── Linear ─────────────────────────────────────────────────────────
export type LinearViewer = {
  displayName: string
  email: string | null
  organizationName: string
}

export type LinearConnectionStatus = {
  connected: boolean
  viewer: LinearViewer | null
}

export type LinearIssue = {
  id: string
  identifier: string
  title: string
  description?: string
  url: string
  state: {
    name: string
    type: string
    color: string
  }
  team: {
    id: string
    name: string
    key: string
  }
  labels: string[]
  labelIds: string[]
  assignee?: {
    id: string
    displayName: string
    avatarUrl?: string
  }
  priority: number
  updatedAt: string
}

export type LinearComment = {
  id: string
  body: string
  createdAt: string
  user?: {
    displayName: string
    avatarUrl?: string
  }
}

// ─── Issue Mutations ────────────────────────────────────────────────

export type GitHubIssueUpdate = {
  state?: 'open' | 'closed'
  title?: string
  // Why: body writes are driven by the Project-mode slug-addressed path
  // (`updateIssueBySlug`) because `gh issue edit` does not consistently
  // cover every body-edit case the dialog needs; the repoPath-based
  // `updateIssue` flow keeps ignoring `body` for backward compatibility.
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}

export type LinearIssueUpdate = {
  stateId?: string
  title?: string
  assigneeId?: string | null
  priority?: number
  labelIds?: string[]
}

export type ClassifiedError = {
  type:
    | 'permission_denied'
    | 'not_found'
    | 'issues_disabled'
    | 'validation_error'
    | 'rate_limited'
    | 'network_error'
    | 'unknown'
  message: string
}

// Why: declared here as a shared shape so IPC return envelopes and renderer
// slices can reference the same structural type without importing from main.
// Aliased as `OwnerRepo` in `src/main/github/gh-utils.ts` so main call sites
// can continue using the short local name.
export type GitHubOwnerRepo = { owner: string; repo: string }

/**
 * GitHub API rate-limit buckets surfaced in the TaskPage header so users can
 * see remaining budget before they hit the wall. `core` = REST (5000/hr),
 * `search` = Search API (30/min — hit by countWorkItems), `graphql` =
 * GraphQL (5000 points/hr — hit by project-view + discovery). All three are
 * the buckets this app actually stresses; other buckets (e.g. code_search)
 * are not surfaced because we don't touch them.
 */
export type GitHubRateLimitBucket = {
  remaining: number
  limit: number
  /** Unix epoch seconds when the window resets. */
  resetAt: number
}

export type GitHubRateLimitSnapshot = {
  core: GitHubRateLimitBucket
  search: GitHubRateLimitBucket
  graphql: GitHubRateLimitBucket
  /** Unix epoch ms the snapshot was produced (for "fetched Xs ago" copy). */
  fetchedAt: number
}

export type GetRateLimitResult =
  | { ok: true; snapshot: GitHubRateLimitSnapshot }
  | { ok: false; error: string }

/**
 * Envelope for `gh:listWorkItems`. Carries resolved issue/PR sources so the
 * renderer can render the "Issues from owner/repo" indicator without an
 * extra IPC round-trip, and per-source classified errors so the UI can show
 * a retryable banner when (e.g.) a private upstream 403s.
 *
 * Why piggyback instead of adding `gh:resolveWorkItemSources`: the renderer
 * already round-trips this endpoint on every Tasks refresh, and the source
 * data is a 2-field-per-side metadata add — cheaper than another IPC call.
 *
 * Invariant: `items` always contains whatever succeeded; `errors.issues` indicates
 * the issues-side fetch failed, but any PR-side items that succeeded are still
 * present in `items`. Consumers should render `items` alongside the error banner.
 */
export type ListWorkItemsResult<T> = {
  items: T[]
  sources: {
    issues: GitHubOwnerRepo | null
    prs: GitHubOwnerRepo | null
    /** Raw `upstream` remote resolved for this repo, independent of the
     *  user's preference. Present so the renderer's issue-source selector
     *  can always decide whether to render (upstream exists & differs from
     *  origin) and show both slugs in its tooltips, even when the user has
     *  picked 'origin' and `sources.issues` has collapsed onto origin. */
    upstreamCandidate: GitHubOwnerRepo | null
  }
  errors?: {
    issues?: ClassifiedError
  }
  /** True when the user's per-repo preference was `'upstream'` but no upstream
   *  remote is configured, so the resolver fell back to origin. Renderer uses
   *  this to surface a one-time-per-session toast. Omitted when absent so
   *  existing consumers and test fixtures don't care about it.
   *  Typed as `?: true` (not `?: boolean`) to encode the invariant "present
   *  iff fell-back" — an explicit `false` write would be a bug, so make it a
   *  compile error. */
  issueSourceFellBack?: true
}

export type LinearWorkflowState = {
  id: string
  name: string
  type: string
  color: string
  position: number
}

export type LinearLabel = {
  id: string
  name: string
  color: string
}

export type LinearMember = {
  id: string
  displayName: string
  avatarUrl?: string
}

export type LinearTeam = {
  id: string
  name: string
  key: string
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

export type WorktreeStartupLaunch = {
  command: string
  env?: Record<string, string>
}

export type CreateSparseCheckoutRequest = {
  directories: string[]
  /** Set when the directories came from a saved preset and the user did not
   *  modify them — recorded on WorktreeMeta so the worktree can show "from
   *  preset X" later. Cleared if the user edited the textarea. */
  presetId?: string
}

/** A reusable per-repo sparse directory list. Saved by the user from the
 *  composer; surfaced again the next time they create a worktree in the same
 *  repo. The MVP scope (no preset) is `presetId === undefined`. */
export type SparsePreset = {
  id: string
  repoId: string
  name: string
  directories: string[]
  createdAt: number
  updatedAt: number
}

export type CreateWorktreeArgs = {
  repoId: string
  name: string
  baseBranch?: string
  setupDecision?: SetupDecision
  sparseCheckout?: CreateSparseCheckoutRequest
  /** Telemetry-only: which UI surface initiated this create. Threaded from
   *  the renderer entry point so main can emit `workspace_created` with the
   *  correct `source`. `unknown` is a valid wire value — an unrecognized
   *  surface emits `source: 'unknown'` rather than dropping the event, so
   *  dashboards surface enum-coverage gaps as a slice rather than as
   *  missing data. Optional on the type so older renderer code paths that
   *  pre-date this prop default to `unknown` at the IPC boundary instead
   *  of failing typecheck. */
  telemetrySource?: WorkspaceSource
}

export type CreateWorktreeResult = {
  worktree: Worktree
  setup?: WorktreeSetupLaunch
  warning?: string
  initialBaseStatus?: WorktreeBaseStatusEvent
}

export type WorktreeBaseStatusKind = 'checking' | 'current' | 'drift' | 'base_changed' | 'unknown'

export type WorktreeBaseStatusEvent = {
  repoId: string
  worktreeId: string
  status: WorktreeBaseStatusKind
  base: string
  /** Configured remote name parsed from `base` (longest-prefix match). Absent
   *  when classification skipped optimistic reconcile (e.g. legacy fallback). */
  remote?: string
  behind?: number
  recentSubjects?: string[]
}

export type WorktreeRemoteBranchConflictEvent = {
  repoId: string
  worktreeId: string
  remote: string
  branchName: string
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
      activeNudgeId?: string
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
  | { state: 'downloading'; percent: number; version: string; activeNudgeId?: string }
  | { state: 'downloaded'; version: string; releaseUrl?: string; activeNudgeId?: string }
  | { state: 'error'; message: string; userInitiated?: boolean; activeNudgeId?: string }

// ─── Settings ────────────────────────────────────────────────────────
export type NotificationSettings = {
  enabled: boolean
  agentTaskComplete: boolean
  terminalBell: boolean
  suppressWhenFocused: boolean
  customSoundPath: string | null
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

export type ClaudeManagedAccount = {
  id: string
  email: string
  managedAuthPath: string
  authMethod: 'subscription-oauth' | 'unknown'
  organizationUuid?: string | null
  organizationName?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

export type ClaudeManagedAccountSummary = {
  id: string
  email: string
  authMethod: 'subscription-oauth' | 'unknown'
  organizationUuid?: string | null
  organizationName?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

export type ClaudeRateLimitAccountsState = {
  accounts: ClaudeManagedAccountSummary[]
  activeAccountId: string | null
}

/** All AI coding agents Orca knows how to launch. Used for the agent picker in the new-workspace
 *  flow and for the default-agent setting. Extend this union as new agents are added. */
export type TuiAgent =
  | 'claude' // Claude Code
  | 'codex' // OpenAI Codex
  | 'autohand' // Autohand Code CLI
  | 'opencode' // OpenCode
  | 'pi' // Pi (pi.dev)
  | 'gemini' // Gemini CLI
  | 'aider' // Aider
  | 'goose' // Goose
  | 'amp' // Amp
  | 'kilo' // Kilocode
  | 'kiro' // Kiro
  | 'crush' // Charm/Crush
  | 'aug' // Augment/Auggie
  | 'cline' // Cline
  | 'codebuff' // Codebuff
  | 'continue' // Continue
  | 'cursor' // Cursor
  | 'droid' // Factory Droid
  | 'kimi' // Kimi
  | 'mistral-vibe' // Mistral Vibe
  | 'qwen-code' // Qwen Code
  | 'rovo' // Rovo Dev
  | 'hermes' // Hermes Agent
  | 'copilot' // GitHub Copilot CLI

export type TaskViewPresetId = 'all' | 'issues' | 'review' | 'my-issues' | 'my-prs' | 'prs'

/** Where the repo setup script runs when a worktree is created.
 *  - 'new-tab': open a background tab titled "Setup" and leave focus on the first tab (default).
 *  - 'split-vertical': split the initial terminal pane with a vertical divider.
 *  - 'split-horizontal': split the initial terminal pane with a horizontal divider. */
export type SetupScriptLaunchMode = 'split-vertical' | 'split-horizontal' | 'new-tab'

/** Direction used when the setup script launch mode is a split. */
export type SetupSplitDirection = 'vertical' | 'horizontal'

export type TerminalColorOverrides = {
  foreground?: string
  background?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  selectionForeground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
  // Why: xterm.js ITheme does not expose a `bold` key, but Ghostty users
  // expect the setting to be preserved so a future renderer CSS override
  // or xterm upgrade can honour it without a migration.
  bold?: string
}

export type GlobalSettings = {
  workspaceDir: string
  nestWorkspaces: boolean
  refreshLocalBaseRefOnWorktreeCreate: boolean
  branchPrefix: 'git-username' | 'custom' | 'none'
  branchPrefixCustom: string
  enableGitHubAttribution: boolean
  theme: 'system' | 'dark' | 'light'
  appFontFamily: string
  editorAutoSave: boolean
  editorAutoSaveDelayMs: number
  editorMinimapEnabled: boolean
  terminalFontSize: number
  terminalFontFamily: string
  terminalFontWeight: number
  terminalLineHeight: number
  /** Mirrors VS Code's terminal.integrated.gpuAcceleration shape.
   *  - 'auto': try xterm WebGL and fall back to DOM if the renderer fails.
   *  - 'on': always try xterm WebGL.
   *  - 'off': keep terminal rendering on xterm's DOM renderer. */
  terminalGpuAcceleration: 'auto' | 'on' | 'off'
  /** Whether to enable programming-ligatures rendering via
   *  `@xterm/addon-ligatures`.
   *  - `'auto'` (default): enabled only when the configured font is known to
   *    ship ligatures (Fira Code, JetBrains Mono, Cascadia Code, etc.). This
   *    keeps the out-of-the-box experience right for users who install a
   *    ligature font without touching settings.
   *  - `'on'` / `'off'`: explicit override. Never changes when the user
   *    switches fonts, so "off" always stays off. */
  terminalLigatures: 'auto' | 'on' | 'off'
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
  terminalBackgroundOpacity?: number
  terminalColorOverrides?: TerminalColorOverrides
  terminalPaddingX?: number
  terminalPaddingY?: number
  terminalMouseHideWhileTyping?: boolean
  terminalWordSeparator?: string
  terminalCursorOpacity?: number
  windowBackgroundBlur?: boolean
  /** Why: Windows terminals conventionally use right-click as a paste gesture.
   *  The setting stays Windows-only so macOS/Linux keep their existing context
   *  menu behavior and users can still reach the menu with Ctrl+right-click. */
  terminalRightClickToPaste: boolean
  /** Why: COMSPEC always points to cmd.exe on stock Windows, so without an
   *  explicit setting the terminal would always open CMD instead of the
   *  user's preferred shell. Defaults to 'powershell.exe' which is the
   *  modern choice for an IDE context. Only consulted on Windows. */
  terminalWindowsShell: string
  /** Why: "PowerShell" is the product-facing shell family. Auto resolves to
   *  PowerShell 7+ when present and falls back to inbox Windows PowerShell. */
  terminalWindowsPowerShellImplementation: 'auto' | 'powershell.exe' | 'pwsh.exe'
  terminalFocusFollowsMouse: boolean
  /** Why: mirrors X11 / gnome-terminal "copy on select" UX — making a terminal
   *  selection copies it to the system clipboard automatically, so users can
   *  paste with Cmd/Ctrl+V without an intervening Cmd/Ctrl+Shift+C. Defaults
   *  to false so existing users keep the explicit-copy behavior. */
  terminalClipboardOnSelect: boolean
  /** Why: lets TUIs like tmux, nvim, and fzf copy to the system clipboard via
   *  the OSC 52 escape sequence — essential for SSH-hosted workflows where
   *  the terminal is the only bridge to the local clipboard. Defaults to
   *  false because OSC 52 is a classic data-exfiltration vector (any
   *  process piping untrusted output into the terminal — `cat attacker.log`
   *  — can silently rewrite the user's clipboard). Opt-in preserves the
   *  conservative default while making the capability one toggle away. */
  terminalAllowOsc52Clipboard: boolean
  /** Where the repo setup script runs on workspace create. Defaults to a
   *  background "Setup" tab so the user's main terminal stays immediately
   *  usable without the setup output crowding the initial pane. */
  setupScriptLaunchMode: SetupScriptLaunchMode
  terminalScrollbackBytes: number
  /** Why: opening arbitrary links inside Orca uses an isolated guest browser surface.
   *  The setting stays opt-in so existing workflows continue to use the system browser
   *  until the user explicitly wants worktree-scoped in-app browsing. */
  openLinksInApp: boolean
  rightSidebarOpenByDefault: boolean
  /** Whether to show the live agent activity count badge in the titlebar. */
  showTitlebarAgentActivity: boolean
  /** Why: some users do not use the Tasks feature and prefer to keep the
   *  left sidebar free of its button entirely. Hiding the button here also
   *  removes it from keyboard navigation. */
  showTasksButton: boolean
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
  /** Why: Claude Code keeps conversations under one shared config root. Orca
   *  persists only per-account auth material here so switching accounts does
   *  not fork prior chat/session context the way CLAUDE_CONFIG_DIR swapping would. */
  claudeManagedAccounts: ClaudeManagedAccount[]
  activeClaudeManagedAccountId: string | null
  /** When true, each worktree gets its own shell history file so ArrowUp
   *  does not surface commands from other worktrees. Defaults to true.
   *  Disable to revert to shared global shell history. */
  terminalScopeHistoryByWorktree: boolean
  /** Which agent to pre-select in the new-workspace composer.
   *  - null: auto (first detected agent)
   *  - 'blank': blank terminal (no agent launched)
   *  - TuiAgent: a specific agent id */
  defaultTuiAgent: TuiAgent | 'blank' | null
  /** Why: worktree deletion is destructive (git worktree remove + rm -rf of the
   *  working directory), so Orca shows a confirmation dialog by default. Users
   *  who delete frequently can opt into skipping the dialog via a "Don't ask
   *  again" checkbox inside it or from the General settings pane. We keep this
   *  defaulted to false so first-time behavior stays safe. */
  skipDeleteWorktreeConfirm: boolean
  /** Default preset in the new-workspace GitHub task view. */
  defaultTaskViewPreset: TaskViewPresetId
  /** Why: persists the user's last-used task source so the Tasks page
   *  reopens to the same provider instead of always defaulting to GitHub. */
  defaultTaskSource: 'github' | 'linear'
  /** Why: persists the user's repo selection in the cross-repo tasks view.
   *  `null` means sticky-all — every eligible repo is selected, including
   *  repos added in future sessions, so the "All repos" label stays
   *  truthful. An explicit array freezes the curated subset; ids no longer
   *  eligible are silently dropped on load. An empty array after that drop
   *  is treated as `null`. */
  defaultRepoSelection: string[] | null
  /** Why: persists the user's Linear team selection in the tasks view.
   *  Same nullable-array pattern as `defaultRepoSelection`: `null` = sticky-all,
   *  `string[]` = frozen subset of team IDs. */
  defaultLinearTeamSelection: string[] | null
  /** Session cookie for OpenCode Go rate-limit fetching. Stored encrypted. */
  opencodeSessionCookie: string
  /** Optional workspace ID override for OpenCode Go. When set, skips the
   *  workspaces lookup and fetches usage directly for this workspace. */
  opencodeWorkspaceId: string
  /** Whether to extract OAuth credentials from the local Gemini CLI installation
   *  for rate-limit fetching. Disabled by default for explicit opt-in. */
  geminiCliOAuthEnabled: boolean
  /** Per-agent CLI command overrides. A missing key means use the catalog default binary name. */
  agentCmdOverrides: Partial<Record<TuiAgent, string>>
  /** Why: macOS terminals must choose between letting Option compose layout
   *  characters (@ on German, € on French) or treating Option as Meta/Esc for
   *  readline shortcuts. Mirrors Ghostty's macos-option-as-alt setting — and
   *  like Ghostty, defaults to 'auto', which fingerprints the active keyboard
   *  layout via navigator.keyboard.getLayoutMap() at runtime and picks
   *  'true' for US / US-International and 'false' for everything else.
   *  'auto'  = layout-aware (default). See docs/terminal-option-key-layout-aware-default.md.
   *  'false' = compose (for non-US keyboards);
   *  'true'  = full Meta on both Option keys;
   *  'left' / 'right' = only that Option key acts as Meta, the other composes. */
  terminalMacOptionAsAlt: 'auto' | 'true' | 'false' | 'left' | 'right'
  /** One-shot migration guard for the 'auto' rollout. Before this field landed,
   *  the field defaulted to 'true' for everyone, meaning a persisted 'true'
   *  could either be an explicit user choice or just the old default. On first
   *  launch after upgrade, if this flag is false and the persisted value is
   *  'true', we reset to 'auto' so non-US users stop getting their keyboard
   *  broken by the stale global default. US users land on 'true' anyway via
   *  detection, so no visible behavior change. Then we flip this flag to true
   *  and never migrate again. */
  terminalMacOptionAsAltMigrated: boolean
  experimentalMobile: boolean
  /** Auto-restore window for a phone-fit PTY after the last mobile
   *  subscriber leaves. `null` (default) holds the PTY at phone size
   *  indefinitely; the desktop "Restore" banner remains the explicit
   *  return-to-desktop-size action. A finite millisecond value schedules
   *  an automatic restore that long after the last unsubscribe. Clamped
   *  on read into [5_000ms, 60min] to defend against bad config.
   *  See docs/mobile-fit-hold.md. */
  mobileAutoRestoreFitMs: number | null
  /** Experimental: floating animated pet (claude.webp) in the bottom-right
   *  corner. Opt-in because it's a cosmetic joke feature; users who leave it
   *  off never mount the overlay. Toggling takes effect immediately in the
   *  current session (no relaunch) because it is purely renderer-side. */
  experimentalPet: boolean
  /** Legacy persisted key from before the sidekick -> pet rename. Read only
   *  during migration; new writes use experimentalPet. */
  experimentalSidekick?: boolean
  /** Experimental: when creating a worktree, automatically symlink a
   *  user-configured set of files/folders from the primary checkout (e.g.
   *  `.env`, `node_modules`) into the new worktree. Opt-in while the
   *  configuration surface and edge cases (conflicts with existing paths,
   *  cleanup on worktree delete) are still being worked out. */
  experimentalWorktreeSymlinks: boolean
  /** GitHub Project mode state — pinned/recent/active project, last selected
   *  view per project. Optional because profiles created before this feature
   *  landed won't have the key; `getDefaultSettings()` hydrates the empty
   *  default via the persistence merge. */
  githubProjects?: GitHubProjectSettings
  /** Anonymous product-telemetry state. Optional because the one-shot
   *  migration in `Store.load()` is what populates it on first boot of the
   *  telemetry release; before migration runs, the field is absent. After
   *  migration every user has `installId` set and `optedIn` is `true` (new
   *  users) or `null` (existing users awaiting the first-launch banner).
   *
   *  Why this block carries only consent + identity state, not volatile
   *  counters: DAU and crash attribution are both out of v1 scope
   *  (daily_active_user is derived server-side from app_opened; crashes are
   *  handled by a separate crash-reporting lane, not product telemetry). So
   *  there is no lastActiveDate, no lastSessionId, and no heartbeat
   *  timestamp here — adding any of those would amplify the debounced
   *  settings write on a fast cadence and couple user preferences to
   *  volatile telemetry counters. Keep this surface to values that only
   *  change on explicit consent transitions. */
  telemetry?: {
    /** New users: initialized to `true` at install.
     *  Existing users: `null` until they resolve the first-launch banner. */
    optedIn: boolean | null
    /** Anonymous UUID v4. Generated on first run. Stable across launches; not surfaced in the UI. */
    installId: string
    /** Cohort marker set once during migration. True for users with a
     *  pre-existing profile (gates the existing-user opt-in banner);
     *  false for fresh installs (no first-launch surface). */
    existedBeforeTelemetryRelease: boolean
  }
}

export type GhosttyImportPreview = {
  found: boolean
  configPath?: string
  diff: Partial<GlobalSettings>
  unsupportedKeys: string[]
  error?: string
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

export type NotificationSoundResult = {
  played: boolean
  reason?:
    | 'missing-path'
    | 'invalid-path'
    | 'unsupported-type'
    | 'too-large'
    | 'read-failed'
    | 'playback-failed'
    | 'deduped'
}

export type NotificationSoundDataResult =
  | {
      ok: true
      data: Uint8Array
      mimeType: string
      path: string
    }
  | {
      ok: false
      reason: Exclude<NotificationSoundResult['reason'], 'playback-failed'>
    }

export type NotificationSoundPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'missing-path' | 'invalid-path' | 'unsupported-type' }

export type OnboardingOutcome = 'completed' | 'dismissed'

export type OnboardingChecklistState = {
  addedRepo: boolean
  choseAgent: boolean
  ranFirstAgent: boolean
  ranSecondAgentOnSameTask: boolean
  triedCmdJ: boolean
  shapedSidebar: boolean
  reviewedDiff: boolean
  openedPr: boolean
  addedFolder: boolean
  openedFile: boolean
  ranAgentOnFile: boolean
  // Why: UI state flag (panel visibility), not an activation event. The
  // telemetry checklist enum in telemetry-events.ts intentionally omits this.
  dismissed: boolean
}

export type OnboardingState = {
  closedAt: number | null
  outcome: OnboardingOutcome | null
  // Sentinel `-1` = not started; `1..4` = highest wizard step the user
  // finished. Kept as `number` (not a literal union) because callers clamp
  // via `Math.max`/`Math.min` against arbitrary numerics.
  lastCompletedStep: number
  checklist: OnboardingChecklistState
}

export type NotificationPermissionStatusResult = {
  supported: boolean
  platform: NodeJS.Platform
  requested: boolean
}

export type WorktreeCardProperty =
  | 'status'
  | 'unread'
  | 'ci'
  | 'issue'
  | 'pr'
  | 'comment'
  // Why: inline list of agent activity rendered directly inside each
  // workspace card when the experimental agent-activity feature is on. On by
  // default (see DEFAULT_WORKTREE_CARD_PROPERTIES in shared/constants.ts) —
  // live agent activity is the primary reason users opt into the feature.
  // Users who prefer a compact sidebar can uncheck it from the Workspaces
  // view options.
  | 'inline-agents'

export type StatusBarItem = 'claude' | 'codex' | 'gemini' | 'opencode-go' | 'ssh' | 'resource-usage'

export type TaskResumeState = {
  githubMode?: 'items' | 'project'
  githubItemsPreset?: TaskViewPresetId | null
  githubItemsQuery?: string
  linearPreset?: 'assigned' | 'created' | 'all' | 'completed'
  linearQuery?: string
}

export type PersistedUIState = {
  lastActiveRepoId: string | null
  lastActiveWorktreeId: string | null
  sidebarWidth: number
  rightSidebarWidth: number
  groupBy: 'none' | 'repo' | 'pr-status'
  sortBy: 'name' | 'smart' | 'recent' | 'repo'
  showActiveOnly: boolean
  /** Hide the repo's original checked-out branch from workspace navigation
   *  (sidebar and Cmd+J jump palette). Folder-mode repos are unaffected —
   *  the predicate in visible-worktrees.ts excludes worktrees with an empty
   *  branch. Lives alongside showActiveOnly because both are user-facing
   *  sidebar filters reached through the same dropdown. */
  hideDefaultBranchWorkspace: boolean
  filterRepoIds: string[]
  collapsedGroups: string[]
  uiZoomLevel: number
  editorFontZoomLevel: number
  worktreeCardProperties: WorktreeCardProperty[]
  statusBarItems: StatusBarItem[]
  statusBarVisible: boolean
  dismissedUpdateVersion: string | null
  lastUpdateCheckAt: number | null
  pendingUpdateNudgeId?: string | null
  dismissedUpdateNudgeId?: string | null
  /** Whether Orca has already attempted to trigger the macOS notification
   *  permission dialog via a startup notification. Prevents re-firing on
   *  every launch. */
  notificationPermissionRequested?: boolean
  /** Once the user has seen the "your sessions won't be interrupted"
   *  reassurance card, we never show it again. */
  updateReassuranceSeen?: boolean
  /** URL to navigate to when a new browser tab is opened. Null means blank tab.
   *  Phase 3 will expand this to a full BrowserSessionProfile per workspace. */
  browserDefaultUrl?: string | null
  browserDefaultSearchEngine?: 'google' | 'duckduckgo' | 'bing' | 'kagi' | null
  /** Optional Kagi private-session link used only when Kagi is the search engine. */
  browserKagiSessionLink?: string | null
  /** Saved window bounds so the app restores to the user's last position/size
   *  instead of maximizing on every launch. */
  windowBounds?: { x: number; y: number; width: number; height: number } | null
  /** Whether the window was maximized when it was last closed. */
  windowMaximized?: boolean
  /** One-shot migration flag: 'recent' used to mean the weighted smart sort
   *  (v1→v2 rename). When this flag is absent and sortBy is 'recent', the
   *  main-process load() migrates it to 'smart' and sets this flag so the
   *  migration never re-fires — allowing users to intentionally select the
   *  new 'recent' (last-activity) sort without it being clobbered on restart. */
  _sortBySmartMigrated?: boolean
  /** LEGACY one-shot flag from the experimental-toggle era of the inline
   *  agents feature. It was stamped unconditionally on every successful
   *  load() in prior builds (regardless of whether the experiment was on),
   *  so it cannot be used to detect "already migrated under the new
   *  default-on rules" — every prior-RC user already has it set to true on
   *  disk. Kept persisted for forward-compat with rollback to a pre-default-on
   *  build that still reads it; the actual migration gate is now
   *  `_inlineAgentsDefaultedForAllUsers` below. */
  _inlineAgentsDefaultedForExperiment?: boolean
  /** One-shot migration flag for the default-on rollout of the inline
   *  agents feature. Set once on first load after upgrade once the
   *  'inline-agents' card property has been ensured in
   *  `worktreeCardProperties`. Distinct from
   *  `_inlineAgentsDefaultedForExperiment` because that legacy flag was
   *  stamped on every prior load and so is permanently dirty for the
   *  prior-RC opt-out cohort the widened migration is meant to reach. */
  _inlineAgentsDefaultedForAllUsers?: boolean
  /** Snapshot of totalAgentsSpawned captured the first time we see the current
   *  app version. Why: the nag threshold counts agents spawned *since the
   *  user's last update* so a fresh install or new release does not trigger
   *  the notification immediately. Reset whenever starNagAppVersion changes. */
  starNagBaselineAgents?: number | null
  /** The app version that set the current baseline. When the live app version
   *  differs from this value, the baseline is re-captured on next agent
   *  spawn — effectively restarting the nag countdown after each update. */
  starNagAppVersion?: string | null
  /** Next threshold (agents spawned since baseline) at which the star-nag
   *  notification should fire. Starts at 50 and doubles each time the user
   *  dismisses the notification without starring. */
  starNagNextThreshold?: number
  /** Once the user has starred Orca (from any entry point) we permanently
   *  suppress the nag — no further thresholds, no notifications. */
  starNagCompleted?: boolean
  trustedOrcaHooks?: PersistedTrustedOrcaHooks
  /** Whether the experimental pet overlay is currently visible. Separate
   *  from the experimentalPet settings flag so "Hide pet" from the
   *  status-bar menu is a reversible dismiss (re-show without re-enabling the
   *  feature). Absent = treated as true so existing users see the pet
   *  the first time they enable the experimental flag. */
  petVisible?: boolean
  /** Active pet id: one of the bundled ids or a custom UUID from
   *  customPets. Unknown ids fall back to the default at read time so
   *  removing a custom pet the user had selected doesn't leave the
   *  overlay rendering nothing. */
  petId?: string
  /** User-uploaded pet images. Bytes live under the legacy
   *  userData/sidekicks/custom/ folder; this field is the metadata index so
   *  custom pets ride the existing PersistedUIState save pipeline. */
  customPets?: CustomPet[]
  /** On-screen size of the pet overlay in CSS pixels (square box).
   *  Clamped to [PET_SIZE_MIN, PET_SIZE_MAX] when read. */
  petSize?: number
  /** Legacy persisted keys from before the sidekick -> pet rename. Read only
   *  during migration; new writes use the pet* names above. */
  sidekickVisible?: boolean
  sidekickId?: string
  customSidekicks?: CustomPet[]
  sidekickSize?: number
  /** Page-position state for Tasks. Source/repo/team/project selections keep
   *  using their existing settings paths; this only restores transient tabs
   *  and applied searches. */
  taskResumeState?: TaskResumeState
}

export const PET_SIZE_MIN = 60
export const PET_SIZE_MAX = 360
export const PET_SIZE_DEFAULT = 180

/** Metadata for a user-uploaded pet image. `id` is the stable identifier;
 *  the on-disk filename (preserving the original extension) lives in `fileName`.
 *  The renderer never learns the absolute path — it asks main for the bytes
 *  via pet:read using (id, fileName). */
export type CustomPet = {
  id: string
  label: string
  fileName: string
  /** MIME type needed so the renderer builds a Blob with the correct
   *  Content-Type — especially image/svg+xml, which browsers won't render
   *  from a misdeclared blob URL. */
  mimeType: string
  /** Storage layout. `image` = legacy flat file at `custom/<id>.<ext>`.
   *  `bundle` = `.codex-pet` import expanded into `custom/<id>/`. Absent =
   *  legacy `image` for backwards compatibility with persisted state. */
  kind?: 'image' | 'bundle'
  /** Sprite-sheet metadata captured at import time. Present iff this entry
   *  came from a `.codex-pet` bundle and the manifest declared frame layout.
   *  `columns`/`rows`/`sheetWidth`/`sheetHeight` are derived in main from
   *  the decoded sheet so the renderer doesn't need to probe the image. */
  sprite?: {
    frameWidth: number
    frameHeight: number
    columns: number
    rows: number
    sheetWidth: number
    sheetHeight: number
    fps: number
    defaultAnimation?: string
    animations?: Record<string, SpriteAnimation>
  }
  /** Manifest-declared fps captured even when the manifest omits `frame` and
   *  the renderer falls back to auto-detected frames. Lets DetectedSpriteFrame
   *  honor the bundle's intended playback speed instead of a hardcoded 8 fps. */
  spriteFps?: number
}

/** One animation strip within a sprite sheet: `row` is the y-index (0-based)
 *  and `frames` is the number of consecutive cells played left-to-right. */
export type SpriteAnimation = {
  row: number
  frames: number
}

export type PersistedTrustedOrcaHookEntry = {
  contentHash: string
  approvedAt: number
}

export type PersistedTrustedOrcaHookRepo = {
  all?: {
    approvedAt: number
  }
  setup?: PersistedTrustedOrcaHookEntry
  archive?: PersistedTrustedOrcaHookEntry
  issueCommand?: PersistedTrustedOrcaHookEntry
}

export type PersistedTrustedOrcaHooks = Record<string, PersistedTrustedOrcaHookRepo>

// ─── Persistence shape ──────────────────────────────────────────────
export type PersistedState = {
  schemaVersion: number
  repos: Repo[]
  /** Sparse-checkout presets keyed by repoId. Empty record on first launch;
   *  presets are managed from the new-workspace composer and repo settings. */
  sparsePresetsByRepo: Record<string, SparsePreset[]>
  worktreeMeta: Record<string, WorktreeMeta>
  settings: GlobalSettings
  ui: PersistedUIState
  githubCache: {
    pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
    issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
  }
  workspaceSession: WorkspaceSessionState
  sshTargets: SshTarget[]
  onboarding: OnboardingState
}

// ─── Filesystem ─────────────────────────────────────────────
export type DirEntry = {
  name: string
  isDirectory: boolean
  isSymlink: boolean
}

export type MarkdownDocument = {
  filePath: string
  relativePath: string
  basename: string
  name: string
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
  head?: string
  branch?: string
}

// Why: when hasUpstream is false, ahead/behind are placeholder zeros, not a
// "sync" signal — callers must check hasUpstream before treating 0/0 as in-sync.
// Kept separate from GitStatusResult because upstream lookup can fail for
// reasons unrelated to working-tree status (e.g., no upstream is expected).
export type GitUpstreamStatus = {
  hasUpstream: boolean
  upstreamName?: string
  ahead: number
  behind: number
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
  displayColumn?: number
  displayMatchLength?: number
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

// ─── Memory dashboard ──────────────────────────────────────────────
// Resource-metrics snapshot shared across main, preload, and renderer so
// the IPC payload is the same shape everywhere. Memory is in bytes; CPU
// is a percentage (can exceed 100 on multi-core).

/** cpu is percent of a single core — can exceed 100 on multi-core. memory is in bytes. */
export type UsageValues = {
  cpu: number
  memory: number
}

/** The top-level cpu/memory are the sum of main + renderer + other. */
export type AppMemory = UsageValues & {
  main: UsageValues
  renderer: UsageValues
  other: UsageValues
  /** Oldest-first memory samples (bytes) for the whole Orca app, one per
   *  successful collection. Used to render the sparkline in the dashboard.
   *  Empty before the first snapshot is recorded. */
  history: number[]
}

export type SessionMemory = UsageValues & {
  sessionId: string
  paneKey: string | null
  pid: number
}

/** The top-level cpu/memory are the sum of sessions. */
export type WorktreeMemory = UsageValues & {
  worktreeId: string
  worktreeName: string
  repoId: string
  repoName: string
  sessions: SessionMemory[]
  /** Oldest-first memory samples (bytes) for this worktree's tracked
   *  subtrees, one per successful collection. */
  history: number[]
}

export type HostMemory = {
  totalMemory: number
  freeMemory: number
  usedMemory: number
  memoryUsagePercent: number
  cpuCoreCount: number
  loadAverage1m: number
}

export type MemorySnapshot = {
  app: AppMemory
  worktrees: WorktreeMemory[]
  host: HostMemory
  /** Sum of app + all tracked worktree sessions. Percent of a single core, so may exceed 100 on multi-core machines. */
  totalCpu: number
  /** Sum of app + all tracked worktree sessions in bytes. NOT the same as host.totalMemory, which is physical RAM. */
  totalMemory: number
  collectedAt: number
}
