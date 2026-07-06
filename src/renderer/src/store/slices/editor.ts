/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { joinPath } from '@/lib/path'
import { toast } from 'sonner'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { resolveMarkdownLinkTarget } from '@/components/editor/markdown-internal-links'
import {
  buildCheckRunDetailsTabId,
  getCheckRunDetailsTabLabel,
  type OpenCheckRunDetailsState
} from '@/components/editor/check-run-details-tab'
import { openHttpLink } from '@/lib/http-link-routing'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { detectLanguage } from '@/lib/language-detect'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitCommitCompareSummary,
  GitConflictKind,
  GitConflictOperation,
  GitConflictResolutionStatus,
  GitConflictStatusSource,
  GlobalSettings,
  GitPushTarget,
  GitStatusEntry,
  GitStatusResult,
  PersistedOpenFile,
  Tab,
  TabGroup,
  GitUpstreamStatus,
  ActiveRightSidebarTab,
  RightSidebarExplorerView,
  SearchResult,
  WorkspaceSessionState,
  WorkspaceVisibleTabType
} from '../../../../shared/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { clampMarkdownTocPanelWidth } from '../../../../shared/markdown-toc-panel-width'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { RemoteOpKind } from '@/components/right-sidebar/source-control-primary-action'
import { invalidateAutomaticPushTargetUpstreamStatusCache } from '@/components/right-sidebar/push-target-upstream-refresh-cache'
import {
  isNonFastForwardRemoteError,
  resolveRemoteOperationErrorMessage
} from '@/lib/source-control-remote-error'
import { shouldForcePushWithLeaseForUpstream } from '../../../../shared/git-upstream-status'
import {
  fastForwardRuntimeGit,
  fetchRuntimeGit,
  getRuntimeGitUpstreamStatus,
  pullRuntimeGit,
  pushRuntimeGit,
  rebaseRuntimeGitFromBase
} from '@/runtime/runtime-git-client'
import {
  deleteRuntimePath,
  deleteRuntimeRelativePath,
  statRuntimePath
} from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { notifyHostOfMirroredEditorClose } from '@/runtime/close-mirrored-editor-tab'
import { findWorktreeById, getRepoIdFromWorktreeId } from './worktree-helpers'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  addAdditionalValidWorkspaceKeys,
  type WorkspaceSessionHydrationOptions
} from '@/lib/workspace-session-hydration-keys'
import { createUntitledMarkdownFileWithTemplateSelection } from '@/lib/create-untitled-markdown'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'

export type {
  ActiveRightSidebarTab,
  RightSidebarExplorerView,
  RightSidebarTab
} from '../../../../shared/types'

const DEFAULT_FILE_SEARCH_STATE = {
  query: '',
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  includePattern: '',
  excludePattern: '',
  results: null,
  loading: false,
  collapsedFiles: new Set<string>()
} satisfies Omit<
  EditorSlice['fileSearchStateByWorktree'][string],
  'seedRequestId' | 'focusRequestId'
>

function defaultFileSearchState(): EditorSlice['fileSearchStateByWorktree'][string] {
  return { ...DEFAULT_FILE_SEARCH_STATE, collapsedFiles: new Set<string>() }
}

export type DiffSource =
  | 'unstaged'
  | 'staged'
  | 'branch'
  | 'commit'
  | 'combined-all'
  | 'combined-uncommitted'
  | 'combined-branch'
  | 'combined-commit'

export type BranchCompareSnapshot = Pick<
  GitBranchCompareSummary,
  'baseRef' | 'baseOid' | 'compareRef' | 'headOid' | 'mergeBase'
> & {
  compareVersion: string
}

export type CommitCompareSnapshot = Pick<
  GitCommitCompareSummary,
  'commitOid' | 'parentOid' | 'compareRef' | 'baseRef'
> & {
  compareVersion: string
  subject?: string
  message?: string
}

type BranchCompareLike = Pick<
  GitBranchCompareSummary,
  'baseRef' | 'baseOid' | 'compareRef' | 'headOid' | 'mergeBase'
>

function getKnownGitHead(head: string | null | undefined): string | undefined {
  const trimmed = head?.trim()
  return trimmed ? trimmed : undefined
}

function createLoadingBranchCompareSummary(baseRef: string): GitBranchCompareSummary {
  return {
    baseRef,
    baseOid: null,
    compareRef: 'HEAD',
    headOid: null,
    mergeBase: null,
    changedFiles: 0,
    status: 'loading'
  }
}

function branchCompareMatchesStatusHead(
  summary: GitBranchCompareSummary,
  statusHead: string
): boolean {
  const summaryHead = getKnownGitHead(summary.headOid)
  // Why: git status reports '(initial)' for unborn branches, while branch
  // compare represents that same state as a null headOid.
  return summaryHead === statusHead || (statusHead === '(initial)' && summary.headOid === null)
}

type CommitCompareLike = Pick<
  GitCommitCompareSummary,
  'commitOid' | 'parentOid' | 'compareRef' | 'baseRef'
> & {
  subject?: string
  message?: string
}

type CombinedDiffAlternate = {
  source: 'combined-all' | 'combined-branch'
  branchCompare?: BranchCompareSnapshot
}

export type OpenConflictMetadata = {
  kind: 'conflict-editable' | 'conflict-placeholder'
  conflictKind: GitConflictKind
  conflictStatus: GitConflictResolutionStatus
  conflictStatusSource: GitConflictStatusSource
  message?: string
  guidance?: string
}

export type ConflictReviewEntry = {
  path: string
  conflictKind: GitConflictKind
}

export type ConflictReviewState = {
  source: 'live-summary' | 'combined-diff-exclusion'
  snapshotTimestamp: number
  entries: ConflictReviewEntry[]
  selectedFileId?: string
}

export type CombinedDiffSkippedConflict = {
  path: string
  conflictKind: GitConflictKind
}

// Why: OpenFile is a single type (not a discriminated union on `mode`) because
// the tab plumbing (reorder, close, activate) treats all tabs uniformly. However,
// consumers that access `filePath` must be aware that conflict-review tabs use
// the worktree root as filePath, not a real file. Any code that assumes filePath
// points to an actual file should check `mode` first.
//
// `skippedConflicts` is stored directly on the tab state so the exclusion notice
// in combined-diff views is stable for the tab's lifetime. It must NOT be
// reconstructed from live status on every render — the live set can change
// between polls, which would make the notice flicker or become inaccurate.
//
// `branchEntriesSnapshot` exists for the same reason on combined branch diffs:
// the active worktree is the only one guaranteed to keep a live branch-compare
// entry list warm. When the user switches worktrees and comes back, the tab must
// still know which files it was showing even if the live compare data for that
// inactive worktree has not been refreshed yet.
export type OpenFile = {
  id: string // use filePath as unique key
  filePath: string // absolute path
  relativePath: string // relative to worktree root
  worktreeId: string
  language: string
  isDirty: boolean
  // Why: remote untitled cleanup must target the environment that created the
  // file, even if the user switches to Local or another runtime before closing.
  runtimeEnvironmentId?: string | null
  /** Why: markdown preview tabs are separate editor tabs that mirror a source
   *  markdown file's live draft. Storing the source file ID lets the preview
   *  follow unsaved edits from the normal editor without becoming editable
   *  itself or conflating the preview tab's identity with the source tab. */
  markdownPreviewSourceFileId?: string
  /** Optional hash fragment to reveal when a preview tab is opened from a
   *  markdown link such as `./guide.md#setup`. Kept on tab state so repeated
   *  "open preview" actions can retarget an already-open preview tab. */
  markdownPreviewAnchor?: string
  diffSource?: DiffSource
  branchCompare?: BranchCompareSnapshot
  commitCompare?: CommitCompareSnapshot
  branchOldPath?: string
  combinedAlternate?: CombinedDiffAlternate
  combinedAreaFilter?: string // filter combined diff to a specific area (e.g. 'staged', 'unstaged', 'untracked')
  branchEntriesSnapshot?: GitBranchChangeEntry[]
  commitEntriesSnapshot?: GitBranchChangeEntry[]
  /** Why: snapshot uncommitted entries at tab-open time so a subsequent commit
   *  does not yank entries out from under the combined diff, which would rebuild
   *  all sections and lose loaded content + scroll position. */
  uncommittedEntriesSnapshot?: GitStatusEntry[]
  conflict?: OpenConflictMetadata
  skippedConflicts?: CombinedDiffSkippedConflict[]
  conflictReview?: ConflictReviewState
  isPreview?: boolean // preview tabs are replaced when another file is single-clicked
  isUntitled?: boolean // true for files created via "New Markdown" that haven't been renamed yet
  // Why: templated New Markdown files contain real user-visible content at
  // creation time, unlike blank placeholder files that can be discarded.
  deleteUntouchedOnClose?: boolean
  // Why: when an external process (e.g. `git mv`, `rm`) removes the file on
  // disk while it's open, we keep the tab around so the user can still see
  // (and potentially save) their in-memory content. The tab surfaces this as
  // a strikethrough label plus a "deleted"/"renamed" suffix. Cleared if the
  // file reappears on disk at its original path.
  externalMutation?: 'deleted' | 'renamed'
  /** Why: diff bodies are cached in EditorPanel. Re-selecting an existing diff
   * tab from the tree bumps this so the panel refetches instead of reusing a
   * stale snapshot. */
  diffContentReloadNonce?: number
  /** Why: terminal/agent links can be the user's manual recovery path when a
   * remote watcher misses an external write. Bumping this refetches clean tabs. */
  fileContentReloadNonce?: number
  /** Why: CI check full-details tabs are virtual editor tabs backed by fetched
   *  PR check-run metadata instead of a file on disk. */
  checkRunDetails?: OpenCheckRunDetailsState
  /** Why: on the web client an editor tab can either be mirrored from the host
   *  runtime's session snapshot or opened locally by the web user. Only mirrored
   *  tabs may be culled when they vanish from a later host snapshot; locally
   *  opened tabs have no host counterpart and must survive snapshot syncs. */
  mirroredFromRuntimeSession?: boolean
  mode: 'edit' | 'diff' | 'conflict-review' | 'markdown-preview' | 'check-details'
}

export type ActivityBarPosition = 'top' | 'side'

export type MarkdownViewMode = 'source' | 'rich' | 'preview'

// Why: orthogonal to MarkdownViewMode. 'changes' flips the editor tab to a
// diff-against-HEAD rendering (working tree incl. unsaved draft vs HEAD) in
// place of the normal editor, without creating a separate tab. The per-tab
// Tab.contentType stays 'editor' for the whole lifetime; this slice drives
// what EditorPanel *renders* for that tab. See reviews/changes-view-mode-plan.md.
export type EditorViewMode = 'edit' | 'changes'

/** Enough state to restore a tab via `openFile` after `closeFile` (id is always filePath). */
// Why: omit mirroredFromRuntimeSession so a user-reopened tab is never treated
// as host-owned; otherwise the web session sync could cull it on the next snapshot.
export type ClosedEditorTabSnapshot = Omit<
  OpenFile,
  'id' | 'isDirty' | 'mirroredFromRuntimeSession'
>

const MAX_RECENT_CLOSED_EDITOR_TABS = 10

type EditorOpenTargetOptions = {
  targetGroupId?: string
  preview?: boolean
  runtimeEnvironmentId?: string | null
  forceContentReload?: boolean
}

type GitRuntimeOperationOptions = {
  runtimeTargetSettings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  applyUpstreamStatus?: boolean
}

function resolveDiffRuntimeEnvironmentId(
  state: AppState,
  worktreeId: string,
  explicitRuntimeEnvironmentId: string | null | undefined
): string | null | undefined {
  if (explicitRuntimeEnvironmentId !== undefined) {
    return explicitRuntimeEnvironmentId
  }
  // Why: Source Control callers often know only the worktree. Runtime-host
  // diffs still need their owner stamped so content loads through runtime RPC.
  return getRuntimeEnvironmentIdForWorktree(state, worktreeId) ?? undefined
}

export type PendingEditorReveal = {
  filePath: string
  fileId?: string
  line: number
  column: number
  matchLength: number
}

const pendingEditorLineRevealFrameIds = new Set<number>()

function cancelPendingEditorLineRevealFrames(): void {
  if (typeof cancelAnimationFrame === 'function') {
    for (const frameId of pendingEditorLineRevealFrameIds) {
      cancelAnimationFrame(frameId)
    }
  }
  pendingEditorLineRevealFrameIds.clear()
}

function trackEditorLineRevealFrameId(frameId: number): void {
  pendingEditorLineRevealFrameIds.add(frameId)
}

function requestTrackedEditorLineRevealFrame(callback: FrameRequestCallback): void {
  let completed = false
  let frameId: number | undefined
  frameId = requestAnimationFrame((timestamp) => {
    completed = true
    if (frameId !== undefined) {
      pendingEditorLineRevealFrameIds.delete(frameId)
    }
    callback(timestamp)
  })
  if (!completed) {
    trackEditorLineRevealFrameId(frameId)
  }
}

function scheduleEditorLineReveal(
  get: () => AppState,
  filePath: string,
  line: number,
  column?: number,
  fileId?: string
): void {
  // Why: openFile can replace a preview and remount Monaco asynchronously; the
  // reveal must land after that remount or the old editor can clear it.
  cancelPendingEditorLineRevealFrames()
  get().setPendingEditorReveal(null)
  requestTrackedEditorLineRevealFrame(() => {
    requestTrackedEditorLineRevealFrame(() => {
      get().setPendingEditorReveal({
        filePath,
        fileId,
        line,
        column: column ?? 1,
        matchLength: 0
      })
    })
  })
}

export type EditorSlice = {
  // Why: #300 originally kept EditorPanel mounted while hidden so unsaved
  // drafts and autosave timers could survive tab switches. Drafts live in the
  // store instead so the visible editor UI can unmount without losing edits or
  // widening the app-shutdown surface.
  editorDrafts: Record<string, string>
  setEditorDraft: (fileId: string, content: string) => void
  clearEditorDraft: (fileId: string) => void
  clearEditorDrafts: (fileIds: string[]) => void

  // Markdown view mode per file (fileId -> mode)
  markdownViewMode: Record<string, MarkdownViewMode>
  setMarkdownViewMode: (fileId: string, mode: MarkdownViewMode) => void

  // Editor view mode per file (fileId -> mode). Orthogonal to markdownViewMode:
  // a markdown file can be in Raw+Changes, Rendered+Changes, etc. Absent entry
  // means 'edit'.
  editorViewMode: Record<string, EditorViewMode>
  setEditorViewMode: (fileId: string, mode: EditorViewMode) => void

  // Per-file opt-in to render front matter in the markdown preview (#4468).
  // Default is hidden; absent entry means hidden. Storing only the explicit
  // true values keeps the record minimal and the default implicit.
  markdownFrontmatterVisible: Record<string, boolean>
  setMarkdownFrontmatterVisible: (fileId: string, visible: boolean) => void

  // Per-file opt-in to keep the markdown table of contents open. Default is
  // hidden; absent entry means hidden.
  markdownTableOfContentsVisible: Record<string, boolean>
  setMarkdownTableOfContentsVisible: (fileId: string, visible: boolean) => void

  // Markdown table of contents panel sizing
  markdownTocPanelWidth: number
  setMarkdownTocPanelWidth: (width: number) => void

  // Right sidebar
  rightSidebarOpen: boolean
  rightSidebarWidth: number
  rightSidebarTab: ActiveRightSidebarTab
  rightSidebarExplorerView: RightSidebarExplorerView
  rightSidebarRouteRequestId: number
  rightSidebarTabByWorktree: Record<string, ActiveRightSidebarTab>
  rightSidebarExplorerViewByWorktree: Record<string, RightSidebarExplorerView>
  activityBarPosition: ActivityBarPosition
  toggleRightSidebar: () => void
  setRightSidebarOpen: (open: boolean) => void
  setRightSidebarWidth: (width: number) => void
  setRightSidebarTab: (tab: ActiveRightSidebarTab) => void
  setRightSidebarExplorerView: (view: RightSidebarExplorerView) => void
  showRightSidebarFiles: () => void
  showRightSidebarSearch: (payload?: {
    query?: string | null
    includePattern?: string | null
  }) => void
  setActivityBarPosition: (position: ActivityBarPosition) => void

  // File explorer state
  expandedDirs: Record<string, Set<string>> // worktreeId -> set of expanded dir paths
  collapseAllDirs: (worktreeId: string) => void
  collapseDirSubtree: (worktreeId: string, dirPath: string) => void
  toggleDir: (worktreeId: string, dirPath: string) => void
  pendingExplorerReveal: {
    worktreeId: string
    filePath: string
    requestId: number
    flash?: boolean
  } | null
  revealInExplorer: (worktreeId: string, filePath: string) => void
  clearPendingExplorerReveal: () => void

  // Open files / editor tabs
  openFiles: OpenFile[]
  activeFileId: string | null
  activeFileIdByWorktree: Record<string, string | null> // worktreeId -> last active file
  activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType> // worktreeId -> last active tab type
  activeTabType: WorkspaceVisibleTabType
  setActiveTabType: (type: WorkspaceVisibleTabType) => void
  openFile: (
    file: Omit<OpenFile, 'id' | 'isDirty'>,
    options?: {
      preview?: boolean
      targetGroupId?: string
      recordReplacedPreview?: boolean
      suppressActiveRuntimeFallback?: boolean
      forceContentReload?: boolean
    }
  ) => void
  openNewMarkdownInActiveWorkspace: (groupId: string) => Promise<void>
  // Why: dispatcher for markdown link activation. Lives on the slice because it
  // sequences openFile, setMarkdownViewMode, and setPendingEditorReveal around
  // an async Monaco remount — all reading/writing state in this slice. See
  // docs/markdown-internal-link-opening-design.md.
  activateMarkdownLink: (
    rawHref: string | undefined,
    ctx: {
      sourceFilePath: string
      worktreeId: string
      worktreeRoot: string | null
      runtimeEnvironmentId?: string | null
    }
  ) => Promise<void>
  openMarkdownPreview: (
    file: Pick<
      OpenFile,
      'filePath' | 'relativePath' | 'worktreeId' | 'language' | 'runtimeEnvironmentId'
    >,
    options?: { anchor?: string | null; targetGroupId?: string; sourceFileId?: string }
  ) => void
  makePreviewFilePermanent: (fileId: string, tabId?: string) => void
  pinFile: (fileId: string, tabId?: string) => void
  closeFile: (fileId: string) => void
  closeAllFiles: () => void
  /** Most recently closed editor tabs per worktree (for Cmd/Ctrl+Shift+T). */
  recentlyClosedEditorTabsByWorktree: Record<string, ClosedEditorTabSnapshot[]>
  reopenClosedEditorTab: (worktreeId: string) => boolean
  setActiveFile: (fileId: string) => void
  reorderFiles: (fileIds: string[]) => void
  markFileDirty: (fileId: string, dirty: boolean) => void
  setExternalMutation: (fileId: string, mutation: 'deleted' | 'renamed' | null) => void
  clearUntitled: (fileId: string) => void
  openDiff: (
    worktreeId: string,
    filePath: string,
    relativePath: string,
    language: string,
    staged: boolean,
    options?: EditorOpenTargetOptions
  ) => void
  openBranchDiff: (
    worktreeId: string,
    worktreePath: string,
    entry: GitBranchChangeEntry,
    compare: BranchCompareLike,
    language: string,
    options?: EditorOpenTargetOptions
  ) => void
  openCommitDiff: (
    worktreeId: string,
    worktreePath: string,
    entry: GitBranchChangeEntry,
    compare: CommitCompareLike,
    language: string,
    options?: EditorOpenTargetOptions
  ) => void
  openAllDiffs: (
    worktreeId: string,
    worktreePath: string,
    alternate?: CombinedDiffAlternate,
    areaFilter?: string,
    entriesSnapshot?: GitStatusEntry[]
  ) => void
  openConflictFile: (
    worktreeId: string,
    worktreePath: string,
    entry: GitStatusEntry,
    language: string,
    options?: EditorOpenTargetOptions
  ) => void
  openConflictReviewFile: (
    reviewFileId: string,
    worktreeId: string,
    worktreePath: string,
    entry: GitStatusEntry,
    language: string
  ) => void
  openConflictReview: (
    worktreeId: string,
    worktreePath: string,
    entries: ConflictReviewEntry[],
    source: ConflictReviewState['source']
  ) => void
  openCheckRunDetails: (
    worktreeId: string,
    contextKey: string,
    check: OpenCheckRunDetailsState['check'],
    state: Pick<OpenCheckRunDetailsState, 'details' | 'loading' | 'error'>
  ) => void
  patchOpenCheckRunDetails: (
    worktreeId: string,
    contextKey: string,
    check: OpenCheckRunDetailsState['check'],
    state: Pick<OpenCheckRunDetailsState, 'details' | 'loading' | 'error'>
  ) => void
  reloadOpenCheckRunDetailsTab: (fileId: string) => Promise<void>
  openBranchAllDiffs: (
    worktreeId: string,
    worktreePath: string,
    compare: GitBranchCompareSummary,
    alternate?: CombinedDiffAlternate
  ) => void
  openCommitAllDiffs: (
    worktreeId: string,
    worktreePath: string,
    compare: GitCommitCompareSummary,
    entries: GitBranchChangeEntry[],
    subject?: string,
    message?: string
  ) => void

  // Cursor line tracking per file
  editorCursorLine: Record<string, number>
  setEditorCursorLine: (fileId: string, line: number) => void

  // Git status cache
  gitStatusByWorktree: Record<string, GitStatusEntry[]>
  gitStatusHeadByWorktree: Record<string, string>
  // Why: when status was truncated at the entry limit (a repo with an enormous
  // un-ignored folder), the SCM view shows a "too many changes" state and
  // polling pauses. `{ limit }` when huge, absent otherwise.
  gitStatusHugeByWorktree: Record<string, { limit: number }>
  gitIgnoredPathsByWorktree: Record<string, string[]>
  gitConflictOperationByWorktree: Record<string, GitConflictOperation>
  trackedConflictPathsByWorktree: Record<string, Record<string, GitConflictKind>>
  trackConflictPath: (worktreeId: string, path: string, conflictKind: GitConflictKind) => void
  setGitStatus: (worktreeId: string, status: GitStatusResult) => void
  // Why: lightweight updater for conflict operation only, used to clear stale
  // "Rebasing"/"Merging" badges on non-active worktrees without a full git status poll.
  setConflictOperation: (worktreeId: string, operation: GitConflictOperation) => void
  remoteStatusesByWorktree: Record<string, GitUpstreamStatus>
  setUpstreamStatus: (worktreeId: string, status: GitUpstreamStatus) => void
  // Why: refcount-backed busy flag. A bare boolean races across worktrees —
  // push on A finishing while pull on B is still in flight would flip the
  // flag off and prematurely re-enable B's button. beginRemoteOperation /
  // endRemoteOperation must be paired (begin at the start of the async
  // operation, end in finally) so the derived boolean only flips to false
  // once every in-flight remote op has finished.
  isRemoteOperationActive: boolean
  remoteOperationDepth: number
  // Why: surfaces *which* remote op the user actually triggered so the
  // primary button can mirror it (label + spinner) rather than leaving a
  // stale label from before the dropdown click. Cleared when depth hits 0.
  // Last-write-wins on concurrent ops, which is fine — the UI disables
  // every entry while busy, so concurrent ops can't be initiated through it.
  inFlightRemoteOpKind: RemoteOpKind | null
  beginRemoteOperation: (kind?: RemoteOpKind) => void
  endRemoteOperation: () => void
  fetchUpstreamStatus: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions
  ) => Promise<GitUpstreamStatus | null>
  pushBranch: (
    worktreeId: string,
    worktreePath: string,
    publish?: boolean,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions & { forceWithLease?: boolean }
  ) => Promise<void>
  pullBranch: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions
  ) => Promise<void>
  fastForwardBranch: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions
  ) => Promise<void>
  syncBranch: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions
  ) => Promise<void>
  rebaseFromBase: (
    worktreeId: string,
    worktreePath: string,
    baseRef: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions
  ) => Promise<void>
  fetchBranch: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: GitRuntimeOperationOptions
  ) => Promise<void>
  gitBranchChangesByWorktree: Record<string, GitBranchChangeEntry[]>
  gitBranchCompareSummaryByWorktree: Record<string, GitBranchCompareSummary | null>
  gitBranchCompareRequestKeyByWorktree: Record<string, string>
  gitBranchCompareRequestStatusHeadByWorktree: Record<string, string | null>
  beginGitBranchCompareRequest: (
    worktreeId: string,
    requestKey: string,
    baseRef: string,
    options?: { preserveExistingSummary?: boolean }
  ) => void
  setGitBranchCompareResult: (
    worktreeId: string,
    requestKey: string,
    result: { summary: GitBranchCompareSummary; entries: GitBranchChangeEntry[] }
  ) => void
  clearGitBranchCompare: (worktreeId: string) => void

  // File search state
  fileSearchStateByWorktree: Record<
    string,
    {
      query: string
      caseSensitive: boolean
      wholeWord: boolean
      useRegex: boolean
      includePattern: string
      excludePattern: string
      results: SearchResult | null
      loading: boolean
      collapsedFiles: Set<string>
      seedRequestId?: number
      focusRequestId?: number
    }
  >
  updateFileSearchState: (
    worktreeId: string,
    updates: Partial<EditorSlice['fileSearchStateByWorktree'][string]>
  ) => void
  seedFileSearchQuery: (worktreeId: string, query: string) => void
  seedFileSearchIncludePattern: (worktreeId: string, includePattern: string) => void
  consumeFileSearchSeedRequest: (worktreeId: string, seedRequestId: number) => void
  toggleFileSearchCollapsedFile: (worktreeId: string, filePath: string) => void
  clearFileSearch: (worktreeId: string) => void

  // Editor navigation (for search result → go-to-line)
  pendingEditorReveal: PendingEditorReveal | null
  setPendingEditorReveal: (reveal: PendingEditorReveal | null) => void

  // Session hydration — restore editor files from persisted workspace session
  hydrateEditorSession: (
    session: WorkspaceSessionState,
    options?: WorkspaceSessionHydrationOptions
  ) => void
}

function openWorkspaceEditorItem(
  state: AppState,
  fileId: string,
  worktreeId: string,
  label: string,
  contentType: 'editor' | 'diff' | 'conflict-review' | 'check-details',
  isPreview?: boolean,
  targetGroupId?: string
): string {
  const resolvedGroupId = resolveEditorOpenTargetGroupId(state, worktreeId, targetGroupId)
  if (resolvedGroupId) {
    const existing = state.findTabForEntityInGroup?.(
      worktreeId,
      resolvedGroupId,
      fileId,
      contentType
    )
    if (existing) {
      // Why: sidebar preview reopens should focus the tab without making it
      // permanent; explicit tab activation still promotes previews by default.
      state.activateTab?.(existing.id, { preservePreview: isPreview })
      return existing.id
    }
  }
  const created = state.createUnifiedTab?.(worktreeId, contentType, {
    entityId: fileId,
    label,
    isPreview,
    ...(resolvedGroupId ? { targetGroupId: resolvedGroupId } : {})
  })
  return created?.id ?? fileId
}

function isEditorTabContentType(contentType: Tab['contentType']): boolean {
  return (
    contentType === 'editor' ||
    contentType === 'diff' ||
    contentType === 'conflict-review' ||
    contentType === 'check-details'
  )
}

function getReplaceablePreviewFileId(
  state: Pick<AppState, 'openFiles' | 'unifiedTabsByWorktree'>,
  worktreeId: string,
  targetGroupId: string | undefined
): string | null {
  const tabsForWorktree = state.unifiedTabsByWorktree?.[worktreeId] ?? []
  if (targetGroupId) {
    const previewTab = tabsForWorktree.find(
      (tab) =>
        tab.groupId === targetGroupId && tab.isPreview && isEditorTabContentType(tab.contentType)
    )
    if (!previewTab) {
      return null
    }
    // Why: split groups may hold separate tabs for the same editor entity. A
    // group-scoped preview replacement must not mutate the shared OpenFile out
    // from under another group's tab.
    const isSharedEntity = tabsForWorktree.some(
      (tab) =>
        tab.id !== previewTab.id &&
        tab.entityId === previewTab.entityId &&
        isEditorTabContentType(tab.contentType)
    )
    if (isSharedEntity) {
      return null
    }
    return (
      state.openFiles.find(
        (file) =>
          file.id === previewTab.entityId && file.worktreeId === worktreeId && file.isPreview
      )?.id ?? null
    )
  }
  return (
    state.openFiles.find((file) => file.worktreeId === worktreeId && file.isPreview)?.id ?? null
  )
}

function removeEditorStateForReplacedPreview(
  state: Pick<
    EditorSlice,
    | 'editorDrafts'
    | 'editorCursorLine'
    | 'markdownViewMode'
    | 'editorViewMode'
    | 'markdownFrontmatterVisible'
    | 'markdownTableOfContentsVisible'
    | 'openFiles'
  >,
  replacedFile: Pick<OpenFile, 'id' | 'markdownPreviewSourceFileId'>,
  nextFileId: string
): Pick<
  EditorSlice,
  | 'editorDrafts'
  | 'editorCursorLine'
  | 'markdownViewMode'
  | 'editorViewMode'
  | 'markdownFrontmatterVisible'
  | 'markdownTableOfContentsVisible'
> {
  const visibilityKeys = [
    replacedFile.id,
    ...(replacedFile.markdownPreviewSourceFileId ? [replacedFile.markdownPreviewSourceFileId] : [])
  ].filter(
    (key) =>
      key !== nextFileId &&
      !state.openFiles.some(
        (file) =>
          file.id !== replacedFile.id &&
          (file.id === key || file.markdownPreviewSourceFileId === key)
      )
  )
  if (replacedFile.id === nextFileId) {
    return {
      editorDrafts: state.editorDrafts,
      editorCursorLine: state.editorCursorLine,
      markdownViewMode: state.markdownViewMode,
      editorViewMode: state.editorViewMode,
      markdownFrontmatterVisible: state.markdownFrontmatterVisible,
      markdownTableOfContentsVisible: state.markdownTableOfContentsVisible
    }
  }
  return {
    editorDrafts: Object.fromEntries(
      Object.entries(state.editorDrafts).filter(([fileId]) => fileId !== replacedFile.id)
    ),
    editorCursorLine: Object.fromEntries(
      Object.entries(state.editorCursorLine).filter(([fileId]) => fileId !== replacedFile.id)
    ),
    markdownViewMode: Object.fromEntries(
      Object.entries(state.markdownViewMode).filter(([fileId]) => fileId !== replacedFile.id)
    ),
    editorViewMode: Object.fromEntries(
      Object.entries(state.editorViewMode).filter(([fileId]) => fileId !== replacedFile.id)
    ),
    markdownFrontmatterVisible: removeMarkdownVisibilityKeys(
      state.markdownFrontmatterVisible,
      visibilityKeys
    ),
    markdownTableOfContentsVisible: removeMarkdownVisibilityKeys(
      state.markdownTableOfContentsVisible,
      visibilityKeys
    )
  }
}

function removeMarkdownVisibilityKeys(
  visibility: Record<string, boolean>,
  keysToRemove: readonly string[]
): Record<string, boolean> {
  let next: Record<string, boolean> | null = null
  for (const key of keysToRemove) {
    if (!(key in visibility)) {
      continue
    }
    next ??= { ...visibility }
    delete next[key]
  }
  return next ?? visibility
}

function getGroupActiveTab(group: TabGroup, tabsById: Map<string, Tab>): Tab | null {
  return group.activeTabId ? (tabsById.get(group.activeTabId) ?? null) : null
}

function getMostRecentEditorTabForGroup(group: TabGroup, tabsById: Map<string, Tab>): Tab | null {
  const seen = new Set<string>()
  const candidateIdLists = [group.recentTabIds ?? [], group.tabOrder]
  for (const candidateIds of candidateIdLists) {
    for (let index = candidateIds.length - 1; index >= 0; index -= 1) {
      const tabId = candidateIds[index]
      if (!tabId || seen.has(tabId)) {
        continue
      }
      seen.add(tabId)
      const tab = tabsById.get(tabId)
      if (tab?.groupId === group.id && isEditorTabContentType(tab.contentType)) {
        return tab
      }
    }
  }
  return null
}

function resolveEditorOpenTargetGroupId(
  state: Pick<AppState, 'activeGroupIdByWorktree' | 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  worktreeId: string,
  explicitTargetGroupId?: string
): string | undefined {
  if (explicitTargetGroupId) {
    return explicitTargetGroupId
  }

  const groups = state.groupsByWorktree?.[worktreeId] ?? []
  if (groups.length === 0) {
    return undefined
  }

  const fallbackGroup = groups[0]
  if (!fallbackGroup) {
    return undefined
  }
  const tabsById = new Map(
    (state.unifiedTabsByWorktree?.[worktreeId] ?? []).map((tab) => [tab.id, tab])
  )
  const activeGroup =
    groups.find((group) => group.id === state.activeGroupIdByWorktree?.[worktreeId]) ??
    fallbackGroup
  const activeTab = getGroupActiveTab(activeGroup, tabsById)
  if (!activeTab || isEditorTabContentType(activeTab.contentType)) {
    return activeGroup.id
  }

  // Why: file explorer opens should reuse an existing editor pane when the
  // focused pane is an agent terminal, instead of turning that terminal pane
  // into an editor tab.
  const visibleEditorGroup = groups.find((group) => {
    if (group.id === activeGroup.id) {
      return false
    }
    const groupActiveTab = getGroupActiveTab(group, tabsById)
    return groupActiveTab ? isEditorTabContentType(groupActiveTab.contentType) : false
  })
  if (visibleEditorGroup) {
    return visibleEditorGroup.id
  }

  const recentEditorGroup = groups.find(
    (group) => group.id !== activeGroup.id && getMostRecentEditorTabForGroup(group, tabsById)
  )
  return recentEditorGroup?.id ?? activeGroup.id
}

function buildEditorActiveResult(
  state: Pick<EditorSlice, 'activeFileIdByWorktree' | 'activeTabTypeByWorktree'>,
  worktreeId: string,
  fileId: string
): {
  activeFileId?: string
  activeTabType?: 'editor'
  activeFileIdByWorktree: Record<string, string | null>
  activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType>
} {
  return {
    // Why: floating markdown tabs use the editor surface without becoming the
    // main worktree's active editor. Updating only the per-worktree maps keeps
    // the workspace behind the floating panel from switching surfaces.
    ...(worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      ? {}
      : { activeFileId: fileId, activeTabType: 'editor' as const }),
    activeFileIdByWorktree: { ...state.activeFileIdByWorktree, [worktreeId]: fileId },
    activeTabTypeByWorktree: { ...state.activeTabTypeByWorktree, [worktreeId]: 'editor' }
  }
}

function runtimeOwnerKey(runtimeEnvironmentId: string | null | undefined): string | null {
  return runtimeEnvironmentId?.trim() || null
}

function isSameEditorOwner(
  file: Pick<OpenFile, 'worktreeId' | 'runtimeEnvironmentId'>,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): boolean {
  return (
    file.worktreeId === worktreeId &&
    runtimeOwnerKey(file.runtimeEnvironmentId) === runtimeOwnerKey(runtimeEnvironmentId)
  )
}

function buildOwnedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeOwnerKey(runtimeEnvironmentId) ?? 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}

function buildDiffEditorFileId(
  worktreeId: string,
  diffSource: DiffSource,
  relativePath: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const legacyId = `${worktreeId}::diff::${diffSource}::${relativePath}`
  const runtimeKey = runtimeOwnerKey(runtimeEnvironmentId)
  return runtimeKey
    ? `editor-diff:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(diffSource)}:${encodeURIComponent(relativePath)}`
    : legacyId
}

function withDiffContentReloadRequest(file: OpenFile): OpenFile {
  return {
    ...file,
    diffContentReloadNonce: (file.diffContentReloadNonce ?? 0) + 1
  }
}

function shouldRequestExistingFileContentReload(
  existing: OpenFile,
  nextMode: OpenFile['mode'],
  options: EditorOpenTargetOptions | undefined
): boolean {
  return (
    options?.forceContentReload === true &&
    !existing.isDirty &&
    (existing.mode === 'edit' || existing.mode === 'markdown-preview') &&
    (nextMode === 'edit' || nextMode === 'markdown-preview')
  )
}

function isEditorFileIdOccupiedByOtherOwner(
  file: Pick<
    OpenFile,
    'id' | 'worktreeId' | 'runtimeEnvironmentId' | 'markdownPreviewSourceFileId'
  >,
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): boolean {
  if (isSameEditorOwner(file, worktreeId, runtimeEnvironmentId)) {
    return false
  }
  return file.id === filePath || file.markdownPreviewSourceFileId === filePath
}

function matchesEditorMode(
  file: OpenFile,
  modes: readonly OpenFile['mode'][] | undefined
): boolean {
  return !modes || modes.includes(file.mode)
}

function getReusableOpenFileModes(mode: OpenFile['mode']): readonly OpenFile['mode'][] {
  // Why: the same path can be open as both a diff and an editable file; matching
  // by path alone collapses those distinct visible tabs onto one OpenFile.
  return [mode]
}

function resolveEditorFileIdForOwner(
  state: Pick<EditorSlice, 'openFiles'>,
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined,
  modes?: readonly OpenFile['mode'][]
): string {
  const existing = state.openFiles.find(
    (file) =>
      file.filePath === filePath &&
      matchesEditorMode(file, modes) &&
      isSameEditorOwner(file, worktreeId, runtimeEnvironmentId)
  )
  if (existing) {
    return existing.id
  }
  // Why: preview-only markdown tabs also reserve their source id. Treat those
  // source ids like open editor ids so same-path owners do not collapse.
  return state.openFiles.some((file) =>
    isEditorFileIdOccupiedByOtherOwner(file, filePath, worktreeId, runtimeEnvironmentId)
  )
    ? buildOwnedEditorFileId(filePath, worktreeId, runtimeEnvironmentId)
    : filePath
}

function getOpenedEditFileIdAfterOpen(
  state: Pick<EditorSlice, 'openFiles' | 'activeFileIdByWorktree'>,
  filePath: string,
  worktreeId: string
): string {
  const activeFileId = state.activeFileIdByWorktree[worktreeId]
  const activeFile = state.openFiles.find(
    (file) =>
      file.id === activeFileId &&
      file.filePath === filePath &&
      file.worktreeId === worktreeId &&
      file.mode === 'edit'
  )
  if (activeFile) {
    return activeFile.id
  }
  return (
    state.openFiles.find(
      (file) => file.filePath === filePath && file.worktreeId === worktreeId && file.mode === 'edit'
    )?.id ?? filePath
  )
}

function shouldHydrateWithOwnedEditorFileId(
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): boolean {
  return (
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID || runtimeOwnerKey(runtimeEnvironmentId) !== null
  )
}

function addEditorFileIdMigration(
  migrationsByWorktree: Record<string, Map<string, string>>,
  worktreeId: string,
  from: string,
  to: string
): void {
  if (from === to) {
    return
  }
  const migrations =
    migrationsByWorktree[worktreeId] ?? (migrationsByWorktree[worktreeId] = new Map())
  migrations.set(from, to)
}

type LegacyHydratedEditorFile = Pick<
  OpenFile,
  'id' | 'filePath' | 'worktreeId' | 'runtimeEnvironmentId' | 'markdownPreviewSourceFileId'
>

function resolveLegacyHydratedEditorFileId(
  files: readonly LegacyHydratedEditorFile[],
  persistedFile: PersistedOpenFile,
  worktreeId: string
): string {
  const existing = files.find(
    (file) =>
      file.filePath === persistedFile.filePath &&
      isSameEditorOwner(file, worktreeId, persistedFile.runtimeEnvironmentId)
  )
  if (existing) {
    return existing.id
  }
  return files.some((file) =>
    isEditorFileIdOccupiedByOtherOwner(
      file,
      persistedFile.filePath,
      worktreeId,
      persistedFile.runtimeEnvironmentId
    )
  )
    ? buildOwnedEditorFileId(persistedFile.filePath, worktreeId, persistedFile.runtimeEnvironmentId)
    : persistedFile.filePath
}

function migrateEditorFileId(
  migrationsByWorktree: Record<string, Map<string, string>>,
  worktreeId: string,
  fileId: string | null | undefined
): string | null {
  if (!fileId) {
    return null
  }
  return migrationsByWorktree[worktreeId]?.get(fileId) ?? fileId
}

function dedupeEditorTabOrder(tabIds: string[], validTabIds: Set<string>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const tabId of tabIds) {
    if (!validTabIds.has(tabId) || seen.has(tabId)) {
      continue
    }
    seen.add(tabId)
    result.push(tabId)
  }
  return result
}

function areStringArraysEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return false
  }
  return a.every((value, index) => value === b[index])
}

function migrateHydratedEditorTabsAndGroups(
  state: Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree'>,
  migrationsByWorktree: Record<string, Map<string, string>>
): Partial<Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree'>> {
  let tabsChanged = false
  let groupsChanged = false
  const nextUnifiedTabsByWorktree: Record<string, Tab[]> = { ...state.unifiedTabsByWorktree }
  const tabIdMigrationsByWorktree: Record<string, Map<string, string>> = {}

  for (const [worktreeId, idMigrations] of Object.entries(migrationsByWorktree)) {
    const tabs = state.unifiedTabsByWorktree[worktreeId]
    if (!tabs) {
      continue
    }
    const tabIdMigrations = new Map<string, string>()
    const nextTabs = tabs.map((tab) => {
      if (tab.contentType !== 'editor') {
        return tab
      }
      const nextId = idMigrations.get(tab.id) ?? tab.id
      const nextEntityId = idMigrations.get(tab.entityId) ?? tab.entityId
      if (nextId === tab.id && nextEntityId === tab.entityId) {
        return tab
      }
      tabsChanged = true
      if (nextId !== tab.id) {
        tabIdMigrations.set(tab.id, nextId)
      }
      return { ...tab, id: nextId, entityId: nextEntityId }
    })
    if (tabIdMigrations.size > 0) {
      tabIdMigrationsByWorktree[worktreeId] = tabIdMigrations
    }
    nextUnifiedTabsByWorktree[worktreeId] = nextTabs
  }

  const nextGroupsByWorktree: Record<string, TabGroup[]> = { ...state.groupsByWorktree }
  for (const [worktreeId, tabIdMigrations] of Object.entries(tabIdMigrationsByWorktree)) {
    const groups = state.groupsByWorktree[worktreeId]
    if (!groups) {
      continue
    }
    const validTabIds = new Set((nextUnifiedTabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
    nextGroupsByWorktree[worktreeId] = groups.map((group) => {
      const tabOrder = dedupeEditorTabOrder(
        group.tabOrder.map((tabId) => tabIdMigrations.get(tabId) ?? tabId),
        validTabIds
      )
      const activeTabId = group.activeTabId
        ? (tabIdMigrations.get(group.activeTabId) ?? group.activeTabId)
        : null
      const validActiveTabId = activeTabId && validTabIds.has(activeTabId) ? activeTabId : null
      const recentTabIds = group.recentTabIds
        ? dedupeEditorTabOrder(
            group.recentTabIds.map((tabId) => tabIdMigrations.get(tabId) ?? tabId),
            validTabIds
          )
        : group.recentTabIds
      if (
        validActiveTabId === group.activeTabId &&
        areStringArraysEqual(tabOrder, group.tabOrder) &&
        areStringArraysEqual(recentTabIds, group.recentTabIds)
      ) {
        return group
      }
      groupsChanged = true
      return {
        ...group,
        activeTabId: validActiveTabId,
        tabOrder,
        recentTabIds
      }
    })
  }

  return {
    ...(tabsChanged ? { unifiedTabsByWorktree: nextUnifiedTabsByWorktree } : {}),
    ...(groupsChanged ? { groupsByWorktree: nextGroupsByWorktree } : {})
  }
}

function deleteUntouchedUntitledFile(state: AppState, file: OpenFile): void {
  const worktree = findWorktreeById(state.worktreesByRepo, file.worktreeId)
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(file.worktreeId)
  const repo = state.repos.find((candidate) => candidate.id === repoId)
  const owningRuntimeEnvironmentId = file.runtimeEnvironmentId?.trim()
  // Why: untitled placeholders may live on a remote runtime or SSH target.
  // Route through the runtime-aware client instead of assuming client-local FS.
  const context = {
    settings: settingsForRuntimeOwner(state.settings, file.runtimeEnvironmentId),
    worktreeId: file.worktreeId,
    worktreePath: worktree?.path ?? null,
    connectionId: repo?.connectionId ?? undefined
  }
  void deleteRuntimeRelativePath(context, file.relativePath)
    .then((deletedRemotely) => {
      if (!deletedRemotely && !owningRuntimeEnvironmentId) {
        return deleteRuntimePath(context, file.filePath)
      }
      return undefined
    })
    .catch(() => {})
}

function shouldDeleteUntouchedUntitledFile(file: OpenFile | undefined, hasDraft: boolean): boolean {
  return (
    file?.isUntitled === true && !file.isDirty && !hasDraft && file.deleteUntouchedOnClose !== false
  )
}

function getWorktreeConnectionId(state: AppState, worktreeId: string): string | undefined {
  const worktree = findWorktreeById(state.worktreesByRepo ?? {}, worktreeId)
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = (state.repos ?? []).find((candidate) => candidate.id === repoId)
  return repo?.connectionId ?? undefined
}

export const createEditorSlice: StateCreator<AppState, [], [], EditorSlice> = (set, get) => ({
  editorDrafts: {},
  setEditorDraft: (fileId, content) =>
    set((s) => ({
      editorDrafts: { ...s.editorDrafts, [fileId]: content }
    })),
  clearEditorDraft: (fileId) =>
    set((s) => {
      if (!(fileId in s.editorDrafts)) {
        return s
      }
      const next = { ...s.editorDrafts }
      delete next[fileId]
      return { editorDrafts: next }
    }),
  clearEditorDrafts: (fileIds) =>
    set((s) => {
      if (fileIds.length === 0) {
        return s
      }
      const next = { ...s.editorDrafts }
      let changed = false
      for (const fileId of fileIds) {
        if (fileId in next) {
          delete next[fileId]
          changed = true
        }
      }
      return changed ? { editorDrafts: next } : s
    }),

  // Markdown view mode
  markdownViewMode: {},
  setMarkdownViewMode: (fileId, mode) =>
    set((s) => ({
      markdownViewMode: { ...s.markdownViewMode, [fileId]: mode }
    })),

  // Editor view mode (edit vs changes-diff). See EditorViewMode.
  editorViewMode: {},
  setEditorViewMode: (fileId, mode) =>
    set((s) => {
      // Why: default is 'edit'. Writing 'edit' explicitly when no entry exists
      // would grow the record unnecessarily; delete instead so the shape stays
      // minimal and hydration round-trips cleanly.
      if (mode === 'edit') {
        if (!(fileId in s.editorViewMode)) {
          return s
        }
        const next = { ...s.editorViewMode }
        delete next[fileId]
        return { editorViewMode: next }
      }
      return { editorViewMode: { ...s.editorViewMode, [fileId]: mode } }
    }),

  // Markdown preview front-matter visibility (#4468). Default is hidden; the
  // preview only renders the front-matter card when the user opts in per file.
  markdownFrontmatterVisible: {},
  setMarkdownFrontmatterVisible: (fileId, visible) =>
    set((s) => {
      // Why: default is hidden. Writing `false` explicitly when no entry exists
      // would grow the record unnecessarily; delete instead so the shape stays
      // minimal and hydration round-trips cleanly — same trade-off as
      // setEditorViewMode above.
      if (!visible) {
        if (!(fileId in s.markdownFrontmatterVisible)) {
          return s
        }
        const next = { ...s.markdownFrontmatterVisible }
        delete next[fileId]
        return { markdownFrontmatterVisible: next }
      }
      return { markdownFrontmatterVisible: { ...s.markdownFrontmatterVisible, [fileId]: true } }
    }),

  // Markdown table of contents visibility
  markdownTableOfContentsVisible: {},
  setMarkdownTableOfContentsVisible: (fileId, visible) =>
    set((s) => {
      if (!visible) {
        if (!(fileId in s.markdownTableOfContentsVisible)) {
          return s
        }
        const next = { ...s.markdownTableOfContentsVisible }
        delete next[fileId]
        return { markdownTableOfContentsVisible: next }
      }
      return {
        markdownTableOfContentsVisible: {
          ...s.markdownTableOfContentsVisible,
          [fileId]: true
        }
      }
    }),

  // Markdown table of contents panel sizing
  markdownTocPanelWidth: 240,
  setMarkdownTocPanelWidth: (width) =>
    set((s) => ({
      markdownTocPanelWidth: clampMarkdownTocPanelWidth(width, undefined, s.markdownTocPanelWidth)
    })),

  // Right sidebar
  rightSidebarOpen: false,
  rightSidebarWidth: 280,
  rightSidebarTab: 'explorer',
  rightSidebarExplorerView: 'files',
  rightSidebarRouteRequestId: 0,
  rightSidebarTabByWorktree: {},
  rightSidebarExplorerViewByWorktree: {},
  activityBarPosition: 'top',
  toggleRightSidebar: () => set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
  setRightSidebarOpen: (open) => set({ rightSidebarOpen: open }),
  setRightSidebarWidth: (width) => set({ rightSidebarWidth: width }),
  setRightSidebarTab: (tab) =>
    set((s) => ({
      rightSidebarTab: tab,
      rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1,
      ...(tab === 'explorer' ? { rightSidebarExplorerView: 'files' as const } : {})
    })),
  setRightSidebarExplorerView: (view) =>
    set((s) => ({
      rightSidebarExplorerView: view,
      rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1,
      ...(s.activeWorktreeId
        ? {
            rightSidebarExplorerViewByWorktree: {
              ...s.rightSidebarExplorerViewByWorktree,
              [s.activeWorktreeId]: view
            }
          }
        : {})
    })),
  showRightSidebarFiles: () =>
    set((s) => ({
      rightSidebarOpen: true,
      rightSidebarTab: 'explorer',
      rightSidebarExplorerView: 'files',
      rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1,
      ...(s.activeWorktreeId
        ? {
            rightSidebarExplorerViewByWorktree: {
              ...s.rightSidebarExplorerViewByWorktree,
              [s.activeWorktreeId]: 'files'
            }
          }
        : {})
    })),
  showRightSidebarSearch: (payload) =>
    set((s) => {
      const next = {
        rightSidebarOpen: true,
        rightSidebarTab: 'explorer' as const,
        rightSidebarExplorerView: 'search' as const,
        rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1,
        ...(s.activeWorktreeId
          ? {
              rightSidebarExplorerViewByWorktree: {
                ...s.rightSidebarExplorerViewByWorktree,
                [s.activeWorktreeId]: 'search' as const
              }
            }
          : {})
      }
      if (!s.activeWorktreeId) {
        return next
      }

      const query = payload?.query?.trim() ? payload.query : null
      const includePattern = payload?.includePattern?.trim() ? payload.includePattern : null
      const current = s.fileSearchStateByWorktree[s.activeWorktreeId] || defaultFileSearchState()
      const shouldSeed = Boolean(query || (includePattern && current.query.trim()))
      const shouldFocus = !shouldSeed
      const nextSearchState = {
        ...current,
        ...(query ? { query } : {}),
        ...(includePattern ? { includePattern } : {}),
        ...(shouldSeed
          ? {
              results: null,
              loading: false,
              collapsedFiles: new Set<string>(),
              seedRequestId: (current.seedRequestId ?? 0) + 1
            }
          : {}),
        ...(shouldFocus ? { focusRequestId: (current.focusRequestId ?? 0) + 1 } : {})
      }

      return {
        ...next,
        fileSearchStateByWorktree: {
          ...s.fileSearchStateByWorktree,
          [s.activeWorktreeId]: nextSearchState
        }
      }
    }),
  setActivityBarPosition: (position) => set({ activityBarPosition: position }),

  // File explorer
  expandedDirs: {},
  collapseAllDirs: (worktreeId) =>
    set((s) => {
      const current = s.expandedDirs[worktreeId]
      if (!current?.size) {
        return s
      }
      return {
        expandedDirs: {
          ...s.expandedDirs,
          [worktreeId]: new Set<string>()
        }
      }
    }),
  collapseDirSubtree: (worktreeId, dirPath) =>
    set((s) => {
      const current = s.expandedDirs[worktreeId]
      if (!current?.size) {
        return s
      }
      const next = new Set(
        Array.from(current).filter((expandedDir) => !isPathInsideOrEqual(dirPath, expandedDir))
      )
      if (next.size === current.size) {
        return s
      }
      return { expandedDirs: { ...s.expandedDirs, [worktreeId]: next } }
    }),
  toggleDir: (worktreeId, dirPath) =>
    set((s) => {
      const current = s.expandedDirs[worktreeId] ?? new Set<string>()
      const next = new Set(current)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
      }
      return { expandedDirs: { ...s.expandedDirs, [worktreeId]: next } }
    }),
  pendingExplorerReveal: null,
  revealInExplorer: (worktreeId, filePath) =>
    set((s) => ({
      rightSidebarOpen: true,
      rightSidebarTab: 'explorer',
      rightSidebarExplorerView: 'files',
      rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1,
      rightSidebarExplorerViewByWorktree: {
        ...s.rightSidebarExplorerViewByWorktree,
        [worktreeId]: 'files'
      },
      pendingExplorerReveal: { worktreeId, filePath, requestId: Date.now() }
    })),
  clearPendingExplorerReveal: () => set({ pendingExplorerReveal: null }),

  // Open files
  openFiles: [],
  activeFileId: null,
  activeFileIdByWorktree: {},
  activeTabTypeByWorktree: {},
  activeTabType: 'terminal',
  recentlyClosedEditorTabsByWorktree: {},
  setActiveTabType: (type) =>
    set((s) => {
      const worktreeId = s.activeWorktreeId
      return {
        activeTabType: type,
        activeTabTypeByWorktree: worktreeId
          ? { ...s.activeTabTypeByWorktree, [worktreeId]: type }
          : s.activeTabTypeByWorktree
      }
    }),

  openFile: (file, options) => {
    let editorItemWorktreeId = file.worktreeId
    let editorItemFileId = file.filePath
    let editorItemLabel = file.relativePath
    let editorItemContentType: 'editor' | 'diff' | 'conflict-review' | 'check-details' =
      file.mode === 'conflict-review'
        ? 'conflict-review'
        : file.mode === 'check-details'
          ? 'check-details'
          : file.mode === 'diff'
            ? 'diff'
            : 'editor'
    let editorItemTargetGroupId = options?.targetGroupId
    set((s) => {
      const worktreeId = file.worktreeId
      const runtimeEnvironmentId =
        file.runtimeEnvironmentId === null
          ? null
          : (file.runtimeEnvironmentId ??
            (options?.suppressActiveRuntimeFallback
              ? null
              : (s.settings?.activeRuntimeEnvironmentId?.trim() ?? undefined)))
      const reusableOpenFileModes = getReusableOpenFileModes(file.mode)
      const existing = s.openFiles.find(
        (f) =>
          f.filePath === file.filePath &&
          matchesEditorMode(f, reusableOpenFileModes) &&
          isSameEditorOwner(f, worktreeId, runtimeEnvironmentId)
      )
      const id = resolveEditorFileIdForOwner(
        s,
        file.filePath,
        worktreeId,
        runtimeEnvironmentId,
        reusableOpenFileModes
      )
      editorItemFileId = id
      const isPreview = options?.preview ?? false
      const recordReplacedPreview = options?.recordReplacedPreview ?? false
      // Why: resolve the target group up-front so preview replacement can be
      // scoped to that group. Opening as preview in group B must not evict a
      // preview tab belonging to group A (split tab groups).
      const targetGroupId =
        resolveEditorOpenTargetGroupId(s, worktreeId, options?.targetGroupId) ?? undefined
      editorItemTargetGroupId = targetGroupId
      const activeResult = buildEditorActiveResult(s, worktreeId, id)

      if (existing) {
        // If opening as non-preview, also pin the existing tab
        const updatedPreview = isPreview ? existing.isPreview : false
        const fileContentReloadNonce = shouldRequestExistingFileContentReload(
          existing,
          file.mode,
          options
        )
          ? (existing.fileContentReloadNonce ?? 0) + 1
          : existing.fileContentReloadNonce
        const needsExistingUpdate =
          existing.mode !== file.mode ||
          existing.diffSource !== file.diffSource ||
          existing.branchCompare?.compareVersion !== file.branchCompare?.compareVersion ||
          existing.commitCompare?.compareVersion !== file.commitCompare?.compareVersion ||
          existing.conflict?.kind !== file.conflict?.kind ||
          existing.conflict?.conflictKind !== file.conflict?.conflictKind ||
          existing.conflict?.conflictStatus !== file.conflict?.conflictStatus ||
          existing.conflictReview?.snapshotTimestamp !== file.conflictReview?.snapshotTimestamp ||
          existing.isPreview !== updatedPreview ||
          existing.language !== file.language ||
          existing.relativePath !== file.relativePath ||
          existing.worktreeId !== file.worktreeId ||
          existing.runtimeEnvironmentId !== runtimeEnvironmentId ||
          existing.fileContentReloadNonce !== fileContentReloadNonce
        if (!needsExistingUpdate) {
          return activeResult
        }
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id
              ? {
                  ...f,
                  relativePath: file.relativePath,
                  worktreeId: file.worktreeId,
                  language: file.language,
                  runtimeEnvironmentId,
                  mode: file.mode,
                  diffSource: file.diffSource,
                  branchCompare: file.branchCompare,
                  commitCompare: file.commitCompare,
                  branchOldPath: file.branchOldPath,
                  combinedAlternate: file.combinedAlternate,
                  combinedAreaFilter: file.combinedAreaFilter,
                  commitEntriesSnapshot: file.commitEntriesSnapshot,
                  conflict: file.conflict,
                  skippedConflicts: file.skippedConflicts,
                  conflictReview: file.conflictReview,
                  isPreview: updatedPreview,
                  fileContentReloadNonce
                }
              : f
          ),
          ...activeResult
        }
      }

      // If opening as preview, replace the existing preview tab.
      // Why: preview replacement is scoped to `worktreeId + targetGroupId` so
      // link clicks in group B do not silently evict previews from group A.
      // Falls back to worktree-wide when group plumbing is unavailable (e.g.
      // in tests that don't populate unifiedTabsByWorktree), matching the
      // prior behavior.
      let newFiles = s.openFiles
      if (isPreview) {
        const replaceablePreviewId = getReplaceablePreviewFileId(s, worktreeId, targetGroupId)
        const existingPreviewIdx = s.openFiles.findIndex((f) => f.id === replaceablePreviewId)
        if (existingPreviewIdx !== -1) {
          const replacedPreview = s.openFiles[existingPreviewIdx]
          // Why: reuse the shared eviction helper (as the four other preview-
          // replacement paths do) so per-file cursor/draft/visibility cleanup stays
          // defined in one place instead of a hand-rolled copy that drifts.
          const {
            editorDrafts: nextEditorDrafts,
            editorCursorLine: nextEditorCursorLine,
            markdownViewMode: nextMarkdownViewMode,
            editorViewMode: nextEditorViewMode,
            markdownFrontmatterVisible: nextMarkdownFrontmatterVisible,
            markdownTableOfContentsVisible: nextMarkdownTableOfContentsVisible
          } = removeEditorStateForReplacedPreview(s, replacedPreview, id)
          // Replace in-place to preserve tab position
          newFiles = s.openFiles.map((f, i) =>
            i === existingPreviewIdx
              ? { ...file, id, isDirty: false, isPreview: true, runtimeEnvironmentId }
              : f
          )
          // Swap the old preview ID for the new one in the stored tab bar order
          const prevOrder = s.tabBarOrderByWorktree?.[worktreeId]
          const previewTabBarUpdate = prevOrder
            ? {
                tabBarOrderByWorktree: {
                  ...s.tabBarOrderByWorktree,
                  [worktreeId]: prevOrder.map((eid) => (eid === replacedPreview.id ? id : eid))
                }
              }
            : {}
          // Why: link-activation replaces previews by default, so users walking
          // A → B → C can't reach A via Cmd/Ctrl+Shift+T unless we push the
          // evicted preview onto the recently-closed stack. Gated with
          // recordReplacedPreview so file-explorer single-click (which
          // semantically *wants* silent eviction) is unaffected.
          let nextRecentlyClosed = s.recentlyClosedEditorTabsByWorktree
          if (recordReplacedPreview && replacedPreview.id !== id) {
            const {
              id: _rid,
              isDirty: _rdirty,
              mirroredFromRuntimeSession: _rmirrored,
              ...snap
            } = replacedPreview
            const stack = s.recentlyClosedEditorTabsByWorktree[worktreeId] ?? []
            nextRecentlyClosed = {
              ...s.recentlyClosedEditorTabsByWorktree,
              [worktreeId]: [snap as ClosedEditorTabSnapshot, ...stack].slice(
                0,
                MAX_RECENT_CLOSED_EDITOR_TABS
              )
            }
          }
          return {
            openFiles: newFiles,
            editorDrafts: nextEditorDrafts,
            editorCursorLine: nextEditorCursorLine,
            markdownViewMode: nextMarkdownViewMode,
            editorViewMode: nextEditorViewMode,
            markdownFrontmatterVisible: nextMarkdownFrontmatterVisible,
            markdownTableOfContentsVisible: nextMarkdownTableOfContentsVisible,
            recentlyClosedEditorTabsByWorktree: nextRecentlyClosed,
            ...previewTabBarUpdate,
            ...activeResult
          }
        }
      }

      // Why: append the new file to the persisted tab bar order so it appears
      // at the end of the tab bar. Without this, reconcileOrder in TabBar
      // falls back to type-grouped ordering (terminals first) when the stored
      // order doesn't contain the new file.
      const tabBarUpdate: Record<string, unknown> = {}
      if (s.tabBarOrderByWorktree) {
        const currentOrder = s.tabBarOrderByWorktree[worktreeId] ?? []
        const terminalIds = (s.tabsByWorktree?.[worktreeId] ?? []).map((t) => t.id)
        const editorFileIds = s.openFiles
          .filter((f) => f.worktreeId === worktreeId)
          .map((f) => f.id)
        const browserIds = (s.browserTabsByWorktree?.[worktreeId] ?? []).map((t) => t.id)
        const allExisting = new Set([...terminalIds, ...editorFileIds, ...browserIds])
        const base = currentOrder.filter((eid) => allExisting.has(eid))
        const inBase = new Set(base)
        for (const eid of [...terminalIds, ...editorFileIds, ...browserIds]) {
          if (!inBase.has(eid)) {
            base.push(eid)
            inBase.add(eid)
          }
        }
        base.push(id)
        tabBarUpdate.tabBarOrderByWorktree = { ...s.tabBarOrderByWorktree, [worktreeId]: base }
      }

      return {
        openFiles: [
          ...newFiles,
          {
            ...file,
            id,
            isDirty: false,
            isPreview: isPreview || undefined,
            runtimeEnvironmentId
          }
        ],
        ...tabBarUpdate,
        ...activeResult
      }
    })
    void openWorkspaceEditorItem(
      get(),
      editorItemFileId,
      editorItemWorktreeId,
      editorItemLabel,
      editorItemContentType,
      options?.preview ?? false,
      editorItemTargetGroupId
    )
  },

  openNewMarkdownInActiveWorkspace: async (groupId) => {
    const state = get()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      return
    }
    const worktree = state.getKnownWorktreeById(worktreeId)
    if (!worktree) {
      return
    }
    try {
      const connectionId =
        state.repos.find((entry) => entry.id === worktree.repoId)?.connectionId ?? undefined
      const fileInfo = await createUntitledMarkdownFileWithTemplateSelection(
        worktree.path,
        worktreeId,
        connectionId,
        get().settings
      )
      if (!fileInfo) {
        return
      }
      get().openFile(fileInfo, { preview: false, targetGroupId: groupId })
      get().recordFeatureInteraction('markdown-file-created')
    } catch (err) {
      toast.error(extractIpcErrorMessage(err, 'Failed to create untitled markdown file.'))
    }
  },

  openMarkdownPreview: (file, options) => {
    const initialState = get()
    const resolvedRuntimeEnvironmentId =
      file.runtimeEnvironmentId === null
        ? null
        : (file.runtimeEnvironmentId ??
          initialState.settings?.activeRuntimeEnvironmentId?.trim() ??
          undefined)
    const sourceFileId =
      options?.sourceFileId ??
      resolveEditorFileIdForOwner(
        initialState,
        file.filePath,
        file.worktreeId,
        resolvedRuntimeEnvironmentId,
        ['edit']
      )
    const id = `markdown-preview::${sourceFileId}`
    const anchor = options?.anchor || undefined
    set((s) => {
      const existing = s.openFiles.find((openFile) => openFile.id === id)
      const worktreeId = file.worktreeId
      const runtimeEnvironmentId = resolvedRuntimeEnvironmentId
      const activeResult = buildEditorActiveResult(s, worktreeId, id)

      if (existing) {
        const needsUpdate =
          existing.relativePath !== file.relativePath ||
          existing.filePath !== file.filePath ||
          existing.language !== file.language ||
          existing.markdownPreviewSourceFileId !== sourceFileId ||
          existing.markdownPreviewAnchor !== anchor ||
          existing.mode !== 'markdown-preview'
        return needsUpdate
          ? {
              openFiles: s.openFiles.map((openFile) =>
                openFile.id === id
                  ? {
                      ...openFile,
                      filePath: file.filePath,
                      relativePath: file.relativePath,
                      worktreeId: file.worktreeId,
                      language: file.language,
                      runtimeEnvironmentId,
                      markdownPreviewSourceFileId: sourceFileId,
                      markdownPreviewAnchor: anchor,
                      mode: 'markdown-preview' as const
                    }
                  : openFile
              ),
              ...activeResult
            }
          : activeResult
      }

      const newFile: OpenFile = {
        id,
        filePath: file.filePath,
        relativePath: file.relativePath,
        worktreeId: file.worktreeId,
        language: file.language,
        isDirty: false,
        runtimeEnvironmentId,
        markdownPreviewSourceFileId: sourceFileId,
        markdownPreviewAnchor: anchor,
        mode: 'markdown-preview'
      }

      return {
        openFiles: [...s.openFiles, newFile],
        ...activeResult
      }
    })
    void openWorkspaceEditorItem(
      get(),
      id,
      file.worktreeId,
      `${file.relativePath} (preview)`,
      'editor',
      false,
      options?.targetGroupId
    )
  },

  makePreviewFilePermanent: (fileId, tabId) => {
    set((s) => {
      let changed = false
      const openFiles = s.openFiles.map((file) => {
        if (file.id !== fileId || !file.isPreview) {
          return file
        }
        changed = true
        return { ...file, isPreview: undefined }
      })
      const unifiedTabsByWorktree: typeof s.unifiedTabsByWorktree = {}
      for (const [worktreeId, tabs] of Object.entries(s.unifiedTabsByWorktree ?? {})) {
        unifiedTabsByWorktree[worktreeId] = tabs.map((tab) => {
          if (tab.entityId !== fileId || (tabId && tab.id !== tabId) || !tab.isPreview) {
            return tab
          }
          changed = true
          return { ...tab, isPreview: false }
        })
      }
      return changed ? { openFiles, unifiedTabsByWorktree } : s
    })
  },

  pinFile: (fileId, tabId) => {
    get().makePreviewFilePermanent(fileId, tabId)
    const state = get()
    for (const tabs of Object.values(state.unifiedTabsByWorktree ?? {})) {
      for (const item of tabs) {
        if (item.entityId === fileId && (!tabId || item.id === tabId)) {
          state.pinTab?.(item.id)
        }
      }
    }
  },

  // Why: closing a tab does NOT clear Resolved locally state. If the file is
  // still present in Changes or Staged Changes, the continuity badge should
  // remain visible until the file leaves the sidebar, the session resets, or
  // the file becomes live-unresolved again. trackedConflictPaths is tied to
  // sidebar presence, not tab lifecycle.
  closeFile: (fileId) => {
    // Why: capture untitled + dirty state before the set() call mutates the
    // store, so we can decide after the tab is removed whether the on-disk
    // file should be cleaned up (untitled files closed without edits are
    // throwaway and should not litter the worktree).
    const preClose = get().openFiles.find((f) => f.id === fileId)
    // Why: also check editorDrafts as a safety net — isDirty is set via a
    // debounced callback from the editor, so there's a narrow window where
    // content exists but isDirty hasn't flushed yet. A draft means the user
    // typed something, so the file should be kept.
    const hasDraft = !!get().editorDrafts[fileId]
    const shouldDeleteFromDisk = shouldDeleteUntouchedUntitledFile(preClose, hasDraft)

    // Why: closeFile is the single chokepoint every editor close funnels through
    // (tab strips, bulk close, save/discard, floating panel). Mirrored tabs are
    // host-owned, so the host must close its copy too or its next snapshot
    // re-mirrors the file and the tab reopens. No-op for the host's own files.
    notifyHostOfMirroredEditorClose(get(), preClose?.worktreeId, fileId)

    set((s) => {
      const closedFile = s.openFiles.find((f) => f.id === fileId)
      const idx = s.openFiles.findIndex((f) => f.id === fileId)
      const newFiles = s.openFiles.filter((f) => f.id !== fileId)
      const newEditorDrafts = { ...s.editorDrafts }
      delete newEditorDrafts[fileId]
      const newMarkdownViewMode = { ...s.markdownViewMode }
      delete newMarkdownViewMode[fileId]
      const newEditorViewMode = { ...s.editorViewMode }
      delete newEditorViewMode[fileId]
      const markdownVisibilityKeys = new Set([fileId])
      if (closedFile?.markdownPreviewSourceFileId) {
        markdownVisibilityKeys.add(closedFile.markdownPreviewSourceFileId)
      }
      const visibilityKeysToRemove = [...markdownVisibilityKeys].filter(
        (key) =>
          !newFiles.some((file) => file.id === key || file.markdownPreviewSourceFileId === key)
      )
      const newMarkdownFrontmatterVisible =
        visibilityKeysToRemove.length > 0
          ? removeMarkdownVisibilityKeys(s.markdownFrontmatterVisible, visibilityKeysToRemove)
          : s.markdownFrontmatterVisible
      const newMarkdownTableOfContentsVisible =
        visibilityKeysToRemove.length > 0
          ? removeMarkdownVisibilityKeys(s.markdownTableOfContentsVisible, visibilityKeysToRemove)
          : s.markdownTableOfContentsVisible
      // Why: editorCursorLine entries are keyed by fileId and accumulate on
      // every cursor move. Without cleanup they grow without bound across a
      // long session as files are opened and closed.
      const newEditorCursorLine = { ...s.editorCursorLine }
      delete newEditorCursorLine[fileId]
      let newActiveId = s.activeFileId
      const newActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }

      if (s.activeFileId === fileId) {
        // Find next file within the same worktree
        const worktreeId = closedFile?.worktreeId
        const worktreeFiles = worktreeId
          ? newFiles.filter((f) => f.worktreeId === worktreeId)
          : newFiles
        if (worktreeFiles.length === 0) {
          newActiveId = null
        } else {
          // Pick adjacent file from same worktree
          const closedWorktreeIdx = worktreeId
            ? s.openFiles
                .filter((f) => f.worktreeId === worktreeId)
                .findIndex((f) => f.id === fileId)
            : idx
          newActiveId =
            closedWorktreeIdx >= worktreeFiles.length
              ? worktreeFiles.at(-1)!.id
              : worktreeFiles[closedWorktreeIdx].id
        }
        if (worktreeId) {
          newActiveFileIdByWorktree[worktreeId] = newActiveId
        }
      }

      // Why: editor tabs share a mixed tab strip with browser tabs. Closing the
      // last editor in a worktree should reveal an available browser tab before
      // falling all the way back to a terminal surface.
      const activeWorktreeId = s.activeWorktreeId
      const remainingForWorktree = activeWorktreeId
        ? newFiles.filter((f) => f.worktreeId === activeWorktreeId)
        : newFiles
      const browserTabsForWorktree = activeWorktreeId
        ? (s.browserTabsByWorktree[activeWorktreeId] ?? [])
        : []
      const terminalTabsForWorktree = activeWorktreeId
        ? (s.tabsByWorktree[activeWorktreeId] ?? [])
        : []
      const fallbackBrowserTabId =
        activeWorktreeId && browserTabsForWorktree.length > 0
          ? (s.activeBrowserTabIdByWorktree[activeWorktreeId] ??
            browserTabsForWorktree[0]?.id ??
            null)
          : s.activeBrowserTabId
      const newActiveTabType =
        remainingForWorktree.length > 0
          ? s.activeTabType
          : browserTabsForWorktree.length > 0
            ? 'browser'
            : 'terminal'
      const newActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
      if (activeWorktreeId && remainingForWorktree.length === 0) {
        newActiveTabTypeByWorktree[activeWorktreeId] =
          browserTabsForWorktree.length > 0 ? 'browser' : 'terminal'
      }
      const shouldDeactivateWorktree =
        activeWorktreeId !== null &&
        remainingForWorktree.length === 0 &&
        browserTabsForWorktree.length === 0 &&
        terminalTabsForWorktree.length === 0

      // Why: keep tabBarOrderByWorktree in sync so stale editor IDs don't
      // linger and cause position shifts the next time the order is reconciled.
      const worktreeId = closedFile?.worktreeId ?? activeWorktreeId
      const nextTabBarOrderByWorktree =
        worktreeId && s.tabBarOrderByWorktree
          ? {
              ...s.tabBarOrderByWorktree,
              [worktreeId]: (s.tabBarOrderByWorktree[worktreeId] ?? []).filter(
                (entryId) => entryId !== fileId
              )
            }
          : s.tabBarOrderByWorktree

      let nextRecentlyClosed = s.recentlyClosedEditorTabsByWorktree
      const wtRecent = closedFile?.worktreeId
      // Why: untitled files that were never edited will be deleted from disk
      // after close. Adding them to the reopen stack would let Cmd+Shift+T
      // try to reopen a path that no longer exists. Preview tabs are also
      // excluded — they are ephemeral views, not user-opened files.
      if (
        closedFile &&
        wtRecent &&
        !shouldDeleteFromDisk &&
        closedFile.mode !== 'markdown-preview'
      ) {
        const {
          id: _id,
          isDirty: _dirty,
          mirroredFromRuntimeSession: _mirrored,
          ...snap
        } = closedFile
        const stack = s.recentlyClosedEditorTabsByWorktree[wtRecent] ?? []
        nextRecentlyClosed = {
          ...s.recentlyClosedEditorTabsByWorktree,
          [wtRecent]: [snap as ClosedEditorTabSnapshot, ...stack].slice(
            0,
            MAX_RECENT_CLOSED_EDITOR_TABS
          )
        }
      }

      return {
        openFiles: newFiles,
        editorDrafts: newEditorDrafts,
        editorCursorLine: newEditorCursorLine,
        activeFileId: newActiveId,
        // Why: if closing the last editor also leaves the worktree without any
        // browser or terminal surface, keep parity with the terminal/browser
        // close handlers and return to the Orca landing state instead of
        // leaving an active worktree selected with nothing renderable.
        activeWorktreeId: shouldDeactivateWorktree ? null : s.activeWorktreeId,
        activeBrowserTabId: shouldDeactivateWorktree
          ? null
          : activeWorktreeId && remainingForWorktree.length === 0
            ? fallbackBrowserTabId
            : s.activeBrowserTabId,
        activeTabType: newActiveTabType,
        activeFileIdByWorktree: newActiveFileIdByWorktree,
        activeTabTypeByWorktree: newActiveTabTypeByWorktree,
        markdownViewMode: newMarkdownViewMode,
        editorViewMode: newEditorViewMode,
        markdownFrontmatterVisible: newMarkdownFrontmatterVisible,
        markdownTableOfContentsVisible: newMarkdownTableOfContentsVisible,
        tabBarOrderByWorktree: nextTabBarOrderByWorktree,
        pendingEditorReveal: null,
        recentlyClosedEditorTabsByWorktree: nextRecentlyClosed
      }
    })

    // Why: untitled files that were never edited are empty placeholders — they
    // exist on disk only because createUntitledMarkdownFile() eagerly writes
    // them so the editor has a real path to bind to. If the user closes the
    // tab without typing anything, the file is just clutter. Fire-and-forget
    // delete; failure (e.g. already removed externally) is harmless.
    if (shouldDeleteFromDisk && preClose && typeof window !== 'undefined') {
      deleteUntouchedUntitledFile(get(), preClose)
    }

    // Why: the unified tab model drives visual tab-bar order and next-active
    // selection (MRU-based, falling back to the visual neighbor). Without
    // this, closing an editor/diff tab picks the next active file from the
    // openFiles array instead of running the unified close path, producing
    // inconsistent behavior vs terminal/browser tab closes which already go
    // through closeUnifiedTab.
    for (const tabs of Object.values(get().unifiedTabsByWorktree ?? {})) {
      const unifiedTab = tabs.find(
        (entry) =>
          entry.entityId === fileId &&
          (entry.contentType === 'editor' ||
            entry.contentType === 'diff' ||
            entry.contentType === 'conflict-review' ||
            entry.contentType === 'check-details')
      )
      if (unifiedTab) {
        get().closeUnifiedTab(unifiedTab.id)
        break
      }
    }
  },

  reopenClosedEditorTab: (worktreeId) => {
    const stack = get().recentlyClosedEditorTabsByWorktree[worktreeId] ?? []
    const next = stack[0]
    if (!next) {
      return false
    }
    set((s) => ({
      recentlyClosedEditorTabsByWorktree: {
        ...s.recentlyClosedEditorTabsByWorktree,
        [worktreeId]: (s.recentlyClosedEditorTabsByWorktree[worktreeId] ?? []).slice(1)
      }
    }))
    get().openFile(next)
    return true
  },

  closeAllFiles: () => {
    const state = get()
    const activeWorktreeId = state.activeWorktreeId

    // Why: same rationale as closeFile — untitled files that were never edited
    // are empty placeholders that should not survive a "close all" operation.
    const untitledToDelete = state.openFiles.filter(
      (f) =>
        shouldDeleteUntouchedUntitledFile(f, !!state.editorDrafts[f.id]) &&
        (!activeWorktreeId || f.worktreeId === activeWorktreeId)
    )
    const closingFiles = state.openFiles.filter(
      (file) => !activeWorktreeId || file.worktreeId === activeWorktreeId
    )
    // Why: close-all bypasses closeFile's per-tab path, so mirrored host-owned
    // editors must be notified here or the next host snapshot reopens them.
    for (const file of closingFiles) {
      notifyHostOfMirroredEditorClose(state, file.worktreeId, file.id)
    }

    const closingItemIds = Object.values(state.unifiedTabsByWorktree ?? {})
      .flat()
      .filter(
        (item) =>
          (item.contentType === 'editor' ||
            item.contentType === 'diff' ||
            item.contentType === 'conflict-review' ||
            item.contentType === 'check-details') &&
          (!activeWorktreeId || item.worktreeId === activeWorktreeId)
      )
      .map((item) => item.id)
    set((s) => {
      const activeWorktreeId = s.activeWorktreeId
      if (!activeWorktreeId) {
        return {
          openFiles: [],
          editorDrafts: {},
          editorCursorLine: {},
          activeFileId: null,
          activeTabType: 'terminal',
          markdownViewMode: {},
          editorViewMode: {},
          markdownFrontmatterVisible: {},
          markdownTableOfContentsVisible: {},
          pendingEditorReveal: null
        }
      }
      // Only close files for the current worktree
      const newFiles = s.openFiles.filter((f) => f.worktreeId !== activeWorktreeId)
      const remainingFileIds = new Set(newFiles.map((f) => f.id))
      const newEditorDrafts = Object.fromEntries(
        Object.entries(s.editorDrafts).filter(([fileId]) => remainingFileIds.has(fileId))
      )
      const newMarkdownViewMode = Object.fromEntries(
        Object.entries(s.markdownViewMode).filter(([fileId]) => remainingFileIds.has(fileId))
      )
      const newEditorViewMode = Object.fromEntries(
        Object.entries(s.editorViewMode).filter(([fileId]) => remainingFileIds.has(fileId))
      )
      const newMarkdownFrontmatterVisible = Object.fromEntries(
        Object.entries(s.markdownFrontmatterVisible).filter(([fileId]) =>
          remainingFileIds.has(fileId)
        )
      )
      const newMarkdownTableOfContentsVisible = Object.fromEntries(
        Object.entries(s.markdownTableOfContentsVisible).filter(([fileId]) =>
          remainingFileIds.has(fileId)
        )
      )
      const newEditorCursorLine = Object.fromEntries(
        Object.entries(s.editorCursorLine).filter(([fileId]) => remainingFileIds.has(fileId))
      )
      const newActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
      delete newActiveFileIdByWorktree[activeWorktreeId]
      const newActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
      const browserTabsForWorktree = s.browserTabsByWorktree[activeWorktreeId] ?? []
      const terminalTabsForWorktree = s.tabsByWorktree[activeWorktreeId] ?? []
      newActiveTabTypeByWorktree[activeWorktreeId] =
        browserTabsForWorktree.length > 0 ? 'browser' : 'terminal'
      const shouldDeactivateWorktree =
        browserTabsForWorktree.length === 0 && terminalTabsForWorktree.length === 0

      // Why: mirrored editor tabs use host tab ids in tab order, while local
      // editor entries may still use file ids. Remove both close-all shapes.
      const closedFileIds = new Set(
        s.openFiles.filter((f) => f.worktreeId === activeWorktreeId).map((f) => f.id)
      )
      const closedTabOrderIds = new Set([...closedFileIds, ...closingItemIds])
      const nextTabBarOrderByWorktree = s.tabBarOrderByWorktree
        ? {
            ...s.tabBarOrderByWorktree,
            [activeWorktreeId]: (s.tabBarOrderByWorktree[activeWorktreeId] ?? []).filter(
              (entryId) => !closedTabOrderIds.has(entryId)
            )
          }
        : s.tabBarOrderByWorktree

      const closingFiles = s.openFiles.filter((f) => f.worktreeId === activeWorktreeId)
      let nextRecentClosed = s.recentlyClosedEditorTabsByWorktree[activeWorktreeId] ?? []
      for (const f of [...closingFiles].toReversed()) {
        // Why: untitled non-dirty files are deleted from disk after close —
        // skip them so the reopen stack doesn't reference vanished paths.
        // Preview tabs are ephemeral views that shouldn't pollute the stack.
        if (
          shouldDeleteUntouchedUntitledFile(f, !!s.editorDrafts[f.id]) ||
          f.mode === 'markdown-preview'
        ) {
          continue
        }
        const { id: _id, isDirty: _dirty, mirroredFromRuntimeSession: _mirrored, ...snap } = f
        nextRecentClosed = [snap as ClosedEditorTabSnapshot, ...nextRecentClosed].slice(
          0,
          MAX_RECENT_CLOSED_EDITOR_TABS
        )
      }

      return {
        openFiles: newFiles,
        editorDrafts: newEditorDrafts,
        editorCursorLine: newEditorCursorLine,
        activeFileId: null,
        // Why: closing every editor in the active worktree can leave no
        // renderable surface at all. Clear the active worktree in that case so
        // the renderer shows the landing page instead of a blank workspace.
        activeWorktreeId: shouldDeactivateWorktree ? null : s.activeWorktreeId,
        activeBrowserTabId: shouldDeactivateWorktree
          ? null
          : browserTabsForWorktree.length > 0
            ? (s.activeBrowserTabIdByWorktree[activeWorktreeId] ??
              browserTabsForWorktree[0]?.id ??
              null)
            : s.activeBrowserTabId,
        activeTabType: browserTabsForWorktree.length > 0 ? 'browser' : 'terminal',
        markdownViewMode: newMarkdownViewMode,
        editorViewMode: newEditorViewMode,
        markdownFrontmatterVisible: newMarkdownFrontmatterVisible,
        markdownTableOfContentsVisible: newMarkdownTableOfContentsVisible,
        activeFileIdByWorktree: newActiveFileIdByWorktree,
        activeTabTypeByWorktree: newActiveTabTypeByWorktree,
        tabBarOrderByWorktree: nextTabBarOrderByWorktree,
        // Why: search-result navigation queues a one-shot reveal for the next
        // editor mount. If the worktree closes all editor tabs before that
        // reveal is consumed, keeping it around would make a later reopen jump
        // to an old match unexpectedly.
        pendingEditorReveal: null,
        recentlyClosedEditorTabsByWorktree: {
          ...s.recentlyClosedEditorTabsByWorktree,
          [activeWorktreeId]: nextRecentClosed
        }
      }
    })
    if (typeof window !== 'undefined') {
      const postCloseState = get()
      for (const f of untitledToDelete) {
        deleteUntouchedUntitledFile(postCloseState, f)
      }
    }
    for (const itemId of closingItemIds) {
      get().closeUnifiedTab?.(itemId)
    }
  },

  setActiveFile: (fileId) => {
    set((s) => {
      const file = s.openFiles.find((f) => f.id === fileId)
      const worktreeId = file?.worktreeId
      return {
        activeFileId: fileId,
        activeFileIdByWorktree: worktreeId
          ? { ...s.activeFileIdByWorktree, [worktreeId]: fileId }
          : s.activeFileIdByWorktree
      }
    })
    const state = get()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      return
    }
    const groupId =
      state.activeGroupIdByWorktree?.[worktreeId] ?? state.groupsByWorktree?.[worktreeId]?.[0]?.id
    if (!groupId) {
      return
    }
    const item =
      state.findTabForEntityInGroup?.(worktreeId, groupId, fileId, 'editor') ??
      state.findTabForEntityInGroup?.(worktreeId, groupId, fileId, 'diff') ??
      state.findTabForEntityInGroup?.(worktreeId, groupId, fileId, 'conflict-review')
    if (item) {
      state.activateTab?.(item.id)
    }
  },

  reorderFiles: (fileIds) =>
    set((s) => {
      const reorderedSet = new Set(fileIds)
      const byId = new Map(s.openFiles.map((f) => [f.id, f]))
      const reordered = fileIds.map((id) => byId.get(id)).filter(Boolean) as OpenFile[]
      // Replace the reordered subset in-place: keep other-worktree files at their positions
      const result: OpenFile[] = []
      let ri = 0
      for (const f of s.openFiles) {
        if (reorderedSet.has(f.id)) {
          result.push(reordered[ri++])
        } else {
          result.push(f)
        }
      }
      return { openFiles: result }
    }),

  markFileDirty: (fileId, dirty) =>
    set((s) => {
      // Why: typing fires this on every keystroke. Rebuilding openFiles
      // unconditionally thrashes every subscriber (EditorPanel → EditorContent
      // → MonacoEditor re-renders) and produced visible typing lag. Bail out
      // when the dirty bit is already the target value and the preview-promote
      // side effect is a no-op.
      const file = s.openFiles.find((f) => f.id === fileId)
      if (!file) {
        return s
      }
      const needsPreviewClear = dirty && file.isPreview
      if (file.isDirty === dirty && !needsPreviewClear) {
        return s
      }
      const nextOpenFiles = s.openFiles.map((f) =>
        f.id === fileId
          ? { ...f, isDirty: dirty, ...(needsPreviewClear ? { isPreview: undefined } : {}) }
          : f
      )
      return {
        openFiles: nextOpenFiles,
        ...(needsPreviewClear
          ? {
              unifiedTabsByWorktree: Object.fromEntries(
                Object.entries(s.unifiedTabsByWorktree ?? {}).map(([worktreeId, tabs]) => [
                  worktreeId,
                  tabs.map((tab) =>
                    tab.entityId === fileId && isEditorTabContentType(tab.contentType)
                      ? { ...tab, isPreview: false }
                      : tab
                  )
                ])
              )
            }
          : {})
      }
    }),

  setExternalMutation: (fileId, mutation) =>
    set((s) => {
      const file = s.openFiles.find((f) => f.id === fileId)
      if (!file) {
        return s
      }
      const next = mutation ?? undefined
      if (file.externalMutation === next) {
        return s
      }
      return {
        openFiles: s.openFiles.map((f) => (f.id === fileId ? { ...f, externalMutation: next } : f))
      }
    }),

  clearUntitled: (fileId) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) => (f.id === fileId ? { ...f, isUntitled: undefined } : f))
    })),

  openDiff: (worktreeId, filePath, relativePath, language, staged, options) => {
    const isPreview = options?.preview ?? false
    let editorItemTargetGroupId = options?.targetGroupId
    let editorItemFileId = ''
    set((s) => {
      const runtimeEnvironmentId = resolveDiffRuntimeEnvironmentId(
        s,
        worktreeId,
        options?.runtimeEnvironmentId
      )
      const diffSource: DiffSource = staged ? 'staged' : 'unstaged'
      const id = buildDiffEditorFileId(worktreeId, diffSource, relativePath, runtimeEnvironmentId)
      editorItemFileId = id
      const targetGroupId =
        resolveEditorOpenTargetGroupId(s, worktreeId, options?.targetGroupId) ?? undefined
      editorItemTargetGroupId = targetGroupId
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        const updatedPreview = isPreview ? existing.isPreview : false
        const reopenedDiff = withDiffContentReloadRequest({
          ...existing,
          mode: 'diff' as const,
          diffSource,
          conflict: undefined,
          skippedConflicts: undefined,
          conflictReview: undefined,
          isPreview: updatedPreview,
          runtimeEnvironmentId
        })
        return {
          openFiles: s.openFiles.map((f) => (f.id === id ? reopenedDiff : f)),
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }
      const newFile: OpenFile = {
        id,
        filePath,
        relativePath,
        worktreeId,
        language,
        isDirty: false,
        mode: 'diff',
        diffSource,
        conflict: undefined,
        skippedConflicts: undefined,
        conflictReview: undefined,
        isPreview: isPreview || undefined,
        runtimeEnvironmentId
      }
      if (isPreview) {
        const replaceablePreviewId = getReplaceablePreviewFileId(s, worktreeId, targetGroupId)
        const replaceablePreviewIndex = s.openFiles.findIndex(
          (file) => file.id === replaceablePreviewId
        )
        if (replaceablePreviewIndex !== -1) {
          return {
            openFiles: s.openFiles.map((file, index) =>
              index === replaceablePreviewIndex ? newFile : file
            ),
            ...removeEditorStateForReplacedPreview(s, s.openFiles[replaceablePreviewIndex], id),
            activeFileId: id,
            activeTabType: 'editor',
            activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
            activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
          }
        }
      }
      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    })
    void openWorkspaceEditorItem(
      get(),
      editorItemFileId,
      worktreeId,
      relativePath,
      'diff',
      isPreview,
      editorItemTargetGroupId
    )
  },

  openBranchDiff: (worktreeId, worktreePath, entry, compare, language, options) => {
    const branchCompare = toBranchCompareSnapshot(compare)
    const id = `${worktreeId}::diff::branch::${compare.baseRef}::${branchCompare.compareVersion}::${entry.path}`
    const isPreview = options?.preview ?? false
    let editorItemTargetGroupId = options?.targetGroupId
    set((s) => {
      const targetGroupId =
        resolveEditorOpenTargetGroupId(s, worktreeId, options?.targetGroupId) ?? undefined
      editorItemTargetGroupId = targetGroupId
      const runtimeEnvironmentId = resolveDiffRuntimeEnvironmentId(
        s,
        worktreeId,
        options?.runtimeEnvironmentId
      )
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        const updatedPreview = isPreview ? existing.isPreview : false
        const reopenedDiff = withDiffContentReloadRequest({
          ...existing,
          mode: 'diff' as const,
          diffSource: 'branch' as const,
          branchCompare,
          branchOldPath: entry.oldPath,
          conflict: undefined,
          skippedConflicts: undefined,
          conflictReview: undefined,
          isPreview: updatedPreview,
          runtimeEnvironmentId
        })
        return {
          openFiles: s.openFiles.map((f) => (f.id === id ? reopenedDiff : f)),
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }
      const newFile: OpenFile = {
        id,
        filePath: joinPath(worktreePath, entry.path),
        relativePath: entry.path,
        worktreeId,
        language,
        isDirty: false,
        mode: 'diff',
        diffSource: 'branch',
        branchCompare,
        branchOldPath: entry.oldPath,
        conflict: undefined,
        skippedConflicts: undefined,
        conflictReview: undefined,
        isPreview: isPreview || undefined,
        runtimeEnvironmentId
      }
      if (isPreview) {
        const replaceablePreviewId = getReplaceablePreviewFileId(s, worktreeId, targetGroupId)
        const replaceablePreviewIndex = s.openFiles.findIndex(
          (file) => file.id === replaceablePreviewId
        )
        if (replaceablePreviewIndex !== -1) {
          return {
            openFiles: s.openFiles.map((file, index) =>
              index === replaceablePreviewIndex ? newFile : file
            ),
            ...removeEditorStateForReplacedPreview(s, s.openFiles[replaceablePreviewIndex], id),
            activeFileId: id,
            activeTabType: 'editor',
            activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
            activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
          }
        }
      }
      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    })
    void openWorkspaceEditorItem(
      get(),
      id,
      worktreeId,
      entry.path,
      'diff',
      isPreview,
      editorItemTargetGroupId
    )
  },

  openCommitDiff: (worktreeId, worktreePath, entry, compare, language, options) => {
    const commitCompare = toCommitCompareSnapshot(compare)
    const id = `${worktreeId}::diff::commit::${commitCompare.compareVersion}::${entry.path}`
    const isPreview = options?.preview ?? false
    let editorItemTargetGroupId = options?.targetGroupId
    set((s) => {
      const targetGroupId =
        resolveEditorOpenTargetGroupId(s, worktreeId, options?.targetGroupId) ?? undefined
      editorItemTargetGroupId = targetGroupId
      const runtimeEnvironmentId = resolveDiffRuntimeEnvironmentId(
        s,
        worktreeId,
        options?.runtimeEnvironmentId
      )
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        const updatedPreview = isPreview ? existing.isPreview : false
        const reopenedDiff = withDiffContentReloadRequest({
          ...existing,
          mode: 'diff' as const,
          diffSource: 'commit' as const,
          commitCompare,
          branchOldPath: entry.oldPath,
          conflict: undefined,
          skippedConflicts: undefined,
          conflictReview: undefined,
          isPreview: updatedPreview,
          runtimeEnvironmentId
        })
        return {
          openFiles: s.openFiles.map((f) => (f.id === id ? reopenedDiff : f)),
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }
      const newFile: OpenFile = {
        id,
        filePath: joinPath(worktreePath, entry.path),
        relativePath: entry.path,
        worktreeId,
        language,
        isDirty: false,
        mode: 'diff',
        diffSource: 'commit',
        commitCompare,
        branchOldPath: entry.oldPath,
        conflict: undefined,
        skippedConflicts: undefined,
        conflictReview: undefined,
        isPreview: isPreview || undefined,
        runtimeEnvironmentId
      }
      if (isPreview) {
        const replaceablePreviewId = getReplaceablePreviewFileId(s, worktreeId, targetGroupId)
        const replaceablePreviewIndex = s.openFiles.findIndex(
          (file) => file.id === replaceablePreviewId
        )
        if (replaceablePreviewIndex !== -1) {
          return {
            openFiles: s.openFiles.map((file, index) =>
              index === replaceablePreviewIndex ? newFile : file
            ),
            ...removeEditorStateForReplacedPreview(s, s.openFiles[replaceablePreviewIndex], id),
            activeFileId: id,
            activeTabType: 'editor',
            activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
            activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
          }
        }
      }
      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    })
    void openWorkspaceEditorItem(
      get(),
      id,
      worktreeId,
      entry.path,
      'diff',
      isPreview,
      editorItemTargetGroupId
    )
  },

  openAllDiffs: (worktreeId, worktreePath, alternate, areaFilter, entriesSnapshot) => {
    const id = areaFilter
      ? `${worktreeId}::all-diffs::uncommitted::${areaFilter}`
      : `${worktreeId}::all-diffs::uncommitted`
    const label = areaFilter
      ? ({ staged: 'Staged Changes', unstaged: 'Changes', untracked: 'Untracked Files' }[
          areaFilter
        ] ?? 'All Changes')
      : 'All Changes'
    set((s) => {
      const branchSummary = s.gitBranchCompareSummaryByWorktree[worktreeId]
      const branchCompare =
        !areaFilter &&
        branchSummary?.status === 'ready' &&
        branchSummary.baseOid &&
        branchSummary.headOid &&
        branchSummary.mergeBase
          ? toBranchCompareSnapshot(branchSummary)
          : undefined
      const branchEntriesSnapshot = branchCompare
        ? (s.gitBranchChangesByWorktree[worktreeId] ?? [])
        : undefined
      const relevantEntries =
        entriesSnapshot ??
        (s.gitStatusByWorktree[worktreeId] ?? []).filter((entry) => {
          return areaFilter === undefined || entry.area === areaFilter
        })
      const skippedConflicts = relevantEntries
        .filter((entry) => entry.conflictStatus === 'unresolved' && entry.conflictKind)
        .map((entry) => ({ path: entry.path, conflictKind: entry.conflictKind! }))
      // Why: snapshot the entry list at open time so a subsequent commit does
      // not yank entries from under the combined diff view, which would rebuild
      // all sections and lose loaded content + scroll position.
      const uncommittedEntriesSnapshot = relevantEntries
      const id = areaFilter
        ? `${worktreeId}::all-diffs::uncommitted::${areaFilter}`
        : `${worktreeId}::all-diffs::uncommitted`
      const label = areaFilter
        ? ({ staged: 'Staged Changes', unstaged: 'Changes', untracked: 'Untracked Files' }[
            areaFilter
          ] ?? 'All Changes')
        : 'All Changes'
      const runtimeEnvironmentId = resolveDiffRuntimeEnvironmentId(s, worktreeId, undefined)
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id
              ? {
                  ...f,
                  diffSource: branchCompare ? 'combined-all' : 'combined-uncommitted',
                  branchCompare,
                  branchEntriesSnapshot,
                  uncommittedEntriesSnapshot,
                  combinedAlternate: alternate,
                  combinedAreaFilter: areaFilter,
                  skippedConflicts,
                  conflictReview: undefined,
                  conflict: undefined,
                  runtimeEnvironmentId
                }
              : f
          ),
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }
      const newFile: OpenFile = {
        id,
        filePath: worktreePath,
        relativePath: label,
        worktreeId,
        language: 'plaintext',
        isDirty: false,
        mode: 'diff',
        diffSource: branchCompare ? 'combined-all' : 'combined-uncommitted',
        branchCompare,
        branchEntriesSnapshot,
        uncommittedEntriesSnapshot,
        combinedAlternate: alternate,
        combinedAreaFilter: areaFilter,
        skippedConflicts,
        conflictReview: undefined,
        conflict: undefined,
        runtimeEnvironmentId
      }
      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    })
    void openWorkspaceEditorItem(get(), id, worktreeId, label, 'diff')
  },

  openConflictFile: (worktreeId, worktreePath, entry, language, options) => {
    const absolutePath = joinPath(worktreePath, entry.path)
    const isPreview = options?.preview ?? false
    let editorItemTargetGroupId = options?.targetGroupId
    set((s) => {
      const id = absolutePath
      const conflict = toOpenConflictMetadata(entry)
      const targetGroupId =
        resolveEditorOpenTargetGroupId(s, worktreeId, options?.targetGroupId) ?? undefined
      editorItemTargetGroupId = targetGroupId
      const existing = s.openFiles.find((f) => f.id === id)
      const nextTracked =
        entry.conflictStatus === 'unresolved' && entry.conflictKind
          ? {
              ...s.trackedConflictPathsByWorktree[worktreeId],
              [entry.path]: entry.conflictKind
            }
          : s.trackedConflictPathsByWorktree[worktreeId]

      if (!conflict) {
        return s
      }

      if (existing) {
        const updatedPreview = isPreview ? existing.isPreview : false
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id
              ? {
                  ...f,
                  mode: 'edit' as const,
                  language,
                  relativePath: entry.path,
                  filePath: absolutePath,
                  conflict,
                  diffSource: undefined,
                  skippedConflicts: undefined,
                  conflictReview: undefined,
                  isPreview: updatedPreview
                }
              : f
          ),
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' },
          trackedConflictPathsByWorktree:
            nextTracked === s.trackedConflictPathsByWorktree[worktreeId]
              ? s.trackedConflictPathsByWorktree
              : { ...s.trackedConflictPathsByWorktree, [worktreeId]: nextTracked }
        }
      }

      const newFile: OpenFile = {
        id,
        filePath: absolutePath,
        relativePath: entry.path,
        worktreeId,
        language,
        isDirty: false,
        mode: 'edit',
        conflict,
        isPreview: isPreview || undefined
      }

      if (isPreview) {
        const replaceablePreviewId = getReplaceablePreviewFileId(s, worktreeId, targetGroupId)
        const replaceablePreviewIndex = s.openFiles.findIndex(
          (file) => file.id === replaceablePreviewId
        )
        if (replaceablePreviewIndex !== -1) {
          return {
            openFiles: s.openFiles.map((file, index) =>
              index === replaceablePreviewIndex ? newFile : file
            ),
            ...removeEditorStateForReplacedPreview(s, s.openFiles[replaceablePreviewIndex], id),
            activeFileId: id,
            activeTabType: 'editor',
            activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
            activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' },
            trackedConflictPathsByWorktree:
              nextTracked === s.trackedConflictPathsByWorktree[worktreeId]
                ? s.trackedConflictPathsByWorktree
                : { ...s.trackedConflictPathsByWorktree, [worktreeId]: nextTracked }
          }
        }
      }

      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' },
        trackedConflictPathsByWorktree:
          nextTracked === s.trackedConflictPathsByWorktree[worktreeId]
            ? s.trackedConflictPathsByWorktree
            : { ...s.trackedConflictPathsByWorktree, [worktreeId]: nextTracked }
      }
    })
    void openWorkspaceEditorItem(
      get(),
      absolutePath,
      worktreeId,
      entry.path,
      'editor',
      isPreview,
      editorItemTargetGroupId
    )
  },

  openConflictReviewFile: (reviewFileId, worktreeId, worktreePath, entry, language) => {
    const absolutePath = joinPath(worktreePath, entry.path)
    const reviewTab = (get().unifiedTabsByWorktree?.[worktreeId] ?? []).find(
      (tab) => tab.entityId === reviewFileId && tab.contentType === 'conflict-review'
    )
    set((s) => {
      const conflict = toOpenConflictMetadata(entry)
      const existing = s.openFiles.find((f) => f.id === absolutePath)
      const nextTracked =
        entry.conflictStatus === 'unresolved' && entry.conflictKind
          ? {
              ...s.trackedConflictPathsByWorktree[worktreeId],
              [entry.path]: entry.conflictKind
            }
          : s.trackedConflictPathsByWorktree[worktreeId]

      if (!conflict) {
        return s
      }

      const nextOpenFiles = existing
        ? s.openFiles.map((f) =>
            f.id === absolutePath
              ? {
                  ...f,
                  mode: 'edit' as const,
                  language,
                  relativePath: entry.path,
                  filePath: absolutePath,
                  conflict,
                  diffSource: undefined,
                  skippedConflicts: undefined,
                  conflictReview: undefined
                }
              : f.id === reviewFileId && f.conflictReview
                ? {
                    ...f,
                    conflictReview: {
                      ...f.conflictReview,
                      selectedFileId: absolutePath
                    }
                  }
                : f
          )
        : [
            ...s.openFiles.map((f) =>
              f.id === reviewFileId && f.conflictReview
                ? {
                    ...f,
                    conflictReview: {
                      ...f.conflictReview,
                      selectedFileId: absolutePath
                    }
                  }
                : f
            ),
            {
              id: absolutePath,
              filePath: absolutePath,
              relativePath: entry.path,
              worktreeId,
              language,
              isDirty: false,
              mode: 'edit' as const,
              conflict
            }
          ]

      return {
        openFiles: nextOpenFiles,
        activeFileId: reviewFileId,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: reviewFileId },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' },
        trackedConflictPathsByWorktree:
          nextTracked === s.trackedConflictPathsByWorktree[worktreeId]
            ? s.trackedConflictPathsByWorktree
            : { ...s.trackedConflictPathsByWorktree, [worktreeId]: nextTracked }
      }
    })

    // Why: the conflict file needs a normal editor backing tab for save/close
    // flows, but selecting it from Conflict Review must keep the review tab
    // visible. Create the backing tab beside the review tab, then restore focus.
    void openWorkspaceEditorItem(
      get(),
      absolutePath,
      worktreeId,
      entry.path,
      'editor',
      undefined,
      reviewTab?.groupId
    )
    if (reviewTab) {
      get().activateTab?.(reviewTab.id)
    }
  },

  // Why: Review conflicts is launched from Source Control into the editor area,
  // not from Checks. Merge-conflict review is source-control work, not CI/PR
  // status. The tab renders from a stored snapshot (entries + timestamp), not
  // from live status on every paint, so the list is stable even if the live
  // unresolved set changes between polls.
  openConflictReview: (worktreeId, worktreePath, entries, source) => {
    const id = `${worktreeId}::conflict-review`
    set((s) => {
      const conflictReview: ConflictReviewState = {
        source,
        snapshotTimestamp: Date.now(),
        entries
      }
      const existing = s.openFiles.find((f) => f.id === id)

      if (existing) {
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id
              ? {
                  ...f,
                  mode: 'conflict-review' as const,
                  relativePath: 'Conflict Review',
                  filePath: worktreePath,
                  language: 'plaintext',
                  conflictReview,
                  conflict: undefined,
                  skippedConflicts: undefined
                }
              : f
          ),
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }

      const newFile: OpenFile = {
        id,
        filePath: worktreePath,
        relativePath: 'Conflict Review',
        worktreeId,
        language: 'plaintext',
        isDirty: false,
        mode: 'conflict-review',
        conflictReview
      }

      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    })
    void openWorkspaceEditorItem(get(), id, worktreeId, 'Conflict Review', 'conflict-review')
  },

  // Why: the checks sidebar only has room for inline summaries; full logs and
  // annotations belong in the center editor pane like diff tabs.
  openCheckRunDetails: (worktreeId, contextKey, check, state) => {
    const id = buildCheckRunDetailsTabId(worktreeId, check)
    const label = getCheckRunDetailsTabLabel(check)
    const checkRunDetails: OpenCheckRunDetailsState = {
      contextKey,
      check,
      details: state.details,
      loading: state.loading,
      error: state.error
    }
    set((s) => {
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id
              ? {
                  ...f,
                  mode: 'check-details' as const,
                  relativePath: label,
                  language: 'plaintext',
                  checkRunDetails
                }
              : f
          ),
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }

      const newFile: OpenFile = {
        id,
        filePath: id,
        relativePath: label,
        worktreeId,
        language: 'plaintext',
        isDirty: false,
        mode: 'check-details',
        checkRunDetails
      }

      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    })
    void openWorkspaceEditorItem(get(), id, worktreeId, label, 'check-details')
  },

  // Why: sidebar detail fetches can finish after a full-details tab is already
  // open; this updates the tab snapshot without stealing focus from the user.
  patchOpenCheckRunDetails: (worktreeId, contextKey, check, state) => {
    const id = buildCheckRunDetailsTabId(worktreeId, check)
    const nextCheckRunDetails: OpenCheckRunDetailsState = {
      contextKey,
      check,
      details: state.details,
      loading: state.loading,
      error: state.error
    }
    set((s) => {
      const existing = s.openFiles.find((f) => f.id === id)
      if (!existing?.checkRunDetails) {
        return s
      }
      const current = existing.checkRunDetails
      if (
        current.contextKey === nextCheckRunDetails.contextKey &&
        current.check.status === nextCheckRunDetails.check.status &&
        current.check.conclusion === nextCheckRunDetails.check.conclusion &&
        current.loading === nextCheckRunDetails.loading &&
        current.error === nextCheckRunDetails.error &&
        current.details === nextCheckRunDetails.details
      ) {
        return s
      }
      return {
        openFiles: s.openFiles.map((f) =>
          f.id === id ? { ...f, checkRunDetails: nextCheckRunDetails } : f
        )
      }
    })
  },

  reloadOpenCheckRunDetailsTab: async (fileId) => {
    const state = get()
    const file = state.openFiles.find((candidate) => candidate.id === fileId)
    const checkRunDetails = file?.checkRunDetails
    if (!file || file.mode !== 'check-details' || !checkRunDetails) {
      return
    }
    const worktree = findWorktreeById(state.worktreesByRepo, file.worktreeId)
    const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(file.worktreeId)
    const repo = state.repos.find((candidate) => candidate.id === repoId)
    if (!repo?.path) {
      return
    }
    const { contextKey, check } = checkRunDetails
    const patch = (next: Pick<OpenCheckRunDetailsState, 'details' | 'loading' | 'error'>): void => {
      get().patchOpenCheckRunDetails(file.worktreeId, contextKey, check, next)
    }
    patch({ details: checkRunDetails.details, loading: true, error: null })
    try {
      const details = await get().fetchPRCheckDetails(
        repo.path,
        {
          checkRunId: check.checkRunId,
          workflowRunId: check.workflowRunId,
          checkName: check.name,
          url: check.url,
          prRepo: null
        },
        { repoId: repo.id }
      )
      patch({
        details,
        loading: false,
        error: details
          ? null
          : translate(
              'auto.store.slices.editor.checkRunDetailsUnavailable',
              'No details are available for this check.'
            )
      })
    } catch (error) {
      patch({
        details: null,
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : translate(
                'auto.store.slices.editor.checkRunDetailsLoadFailed',
                'Failed to load check details.'
              )
      })
    }
  },

  openBranchAllDiffs: (worktreeId, worktreePath, compare, alternate) => {
    const branchCompare = toBranchCompareSnapshot(compare)
    const id = `${worktreeId}::all-diffs::branch::${compare.baseRef}::${branchCompare.compareVersion}`
    set((s) => {
      const runtimeEnvironmentId = resolveDiffRuntimeEnvironmentId(s, worktreeId, undefined)
      const branchEntriesSnapshot = s.gitBranchChangesByWorktree[worktreeId] ?? []
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id
              ? {
                  ...f,
                  branchCompare,
                  branchEntriesSnapshot,
                  combinedAlternate: alternate,
                  conflict: undefined,
                  skippedConflicts: undefined,
                  conflictReview: undefined,
                  runtimeEnvironmentId
                }
              : f
          ),
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }
      const newFile: OpenFile = {
        id,
        filePath: worktreePath,
        relativePath: `Branch Changes (${compare.baseRef})`,
        worktreeId,
        language: 'plaintext',
        isDirty: false,
        mode: 'diff',
        diffSource: 'combined-branch',
        branchCompare,
        branchEntriesSnapshot,
        combinedAlternate: alternate,
        conflict: undefined,
        skippedConflicts: undefined,
        conflictReview: undefined,
        runtimeEnvironmentId
      }
      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    })
    void openWorkspaceEditorItem(
      get(),
      id,
      worktreeId,
      `Branch Changes (${compare.baseRef})`,
      'diff'
    )
  },

  openCommitAllDiffs: (worktreeId, worktreePath, compare, entries, subject, message) => {
    const commitCompare = toCommitCompareSnapshot(compare, subject, message)
    const id = `${worktreeId}::all-diffs::commit::${commitCompare.commitOid}`
    const label = subject
      ? `Commit ${commitCompare.compareRef}: ${subject}`
      : `Commit ${commitCompare.compareRef}`
    set((s) => {
      const runtimeEnvironmentId = resolveDiffRuntimeEnvironmentId(s, worktreeId, undefined)
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id
              ? {
                  ...f,
                  relativePath: label,
                  commitCompare,
                  commitEntriesSnapshot: entries,
                  conflict: undefined,
                  skippedConflicts: undefined,
                  conflictReview: undefined,
                  runtimeEnvironmentId
                }
              : f
          ),
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }

      const newFile: OpenFile = {
        id,
        filePath: worktreePath,
        relativePath: label,
        worktreeId,
        language: 'plaintext',
        isDirty: false,
        mode: 'diff',
        diffSource: 'combined-commit',
        commitCompare,
        commitEntriesSnapshot: entries,
        conflict: undefined,
        skippedConflicts: undefined,
        conflictReview: undefined,
        runtimeEnvironmentId
      }
      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    })
    void openWorkspaceEditorItem(get(), id, worktreeId, label, 'diff')
  },

  // Cursor line tracking
  editorCursorLine: {},
  setEditorCursorLine: (fileId, line) =>
    set((s) => ({
      editorCursorLine: { ...s.editorCursorLine, [fileId]: line }
    })),

  // Git status
  gitStatusByWorktree: {},
  gitStatusHeadByWorktree: {},
  gitStatusHugeByWorktree: {},
  gitIgnoredPathsByWorktree: {},
  gitConflictOperationByWorktree: {},
  trackedConflictPathsByWorktree: {},
  trackConflictPath: (worktreeId, path, conflictKind) =>
    set((s) => {
      const nextTracked = {
        ...s.trackedConflictPathsByWorktree[worktreeId],
        [path]: conflictKind
      }
      return {
        trackedConflictPathsByWorktree: {
          ...s.trackedConflictPathsByWorktree,
          [worktreeId]: nextTracked
        }
      }
    }),
  // Why: session-local conflict tracking (trackedConflictPaths, Resolved locally
  // state) lives entirely in the renderer and never crosses the IPC boundary.
  // The main process returns only what `git status` reports. The renderer is
  // responsible for setting conflictStatusSource ('git' for live u-records,
  // 'session' for Resolved locally) and for all Resolved locally lifecycle.
  setGitStatus: (worktreeId, status) =>
    set((s) => {
      const hadStatusEntry = Object.prototype.hasOwnProperty.call(s.gitStatusByWorktree, worktreeId)
      const prevEntries = s.gitStatusByWorktree[worktreeId] ?? []
      const prevOperation = s.gitConflictOperationByWorktree[worktreeId] ?? 'unknown'
      const currentTracked = { ...s.trackedConflictPathsByWorktree[worktreeId] }
      // Why: conflictStatusSource is NOT set by the main process. The renderer
      // stamps 'git' here for live u-records, and 'session' below when applying
      // Resolved locally state. This keeps the main process free of session
      // awareness while letting the renderer distinguish the two sources.
      const normalizedEntries = status.entries.map((entry) =>
        entry.conflictStatus === 'unresolved'
          ? { ...entry, conflictStatusSource: 'git' as const }
          : entry
      )
      const unresolvedEntries = normalizedEntries.filter(
        (entry) => entry.conflictStatus === 'unresolved' && entry.conflictKind
      )
      const unresolvedByPath = new Map(unresolvedEntries.map((entry) => [entry.path, entry]))

      // Why: when the operation is aborted (git merge --abort, etc.), all u-records
      // disappear and the HEAD file is cleaned up simultaneously. We detect this as
      // the operation transitioning to 'unknown' with zero unresolved entries. In
      // this case we clear the entire trackedConflictPaths set rather than
      // transitioning each path to Resolved locally — abort is NOT resolution, and
      // showing "Resolved locally" on every previously-conflicted file after an
      // abort would be misleading.
      if (
        status.conflictOperation === 'unknown' &&
        prevOperation !== 'unknown' &&
        unresolvedByPath.size === 0
      ) {
        for (const path of Object.keys(currentTracked)) {
          delete currentTracked[path]
        }
      }

      const nextEntries = normalizedEntries.map((entry) => {
        if (entry.conflictStatus === 'unresolved') {
          return entry
        }
        const trackedConflictKind = currentTracked[entry.path]
        if (!trackedConflictKind) {
          return entry
        }
        return {
          ...entry,
          conflictKind: trackedConflictKind,
          conflictStatus: 'resolved_locally' as const,
          conflictStatusSource: 'session' as const
        }
      })

      const visiblePaths = new Set(nextEntries.map((entry) => entry.path))
      for (const path of Object.keys(currentTracked)) {
        if (!visiblePaths.has(path) && !unresolvedByPath.has(path)) {
          delete currentTracked[path]
        }
      }

      const nextOpenFiles = reconcileOpenFilesForStatus(s.openFiles, worktreeId, nextEntries)
      const statusUnchanged = hadStatusEntry && areGitStatusEntriesEqual(prevEntries, nextEntries)
      const trackedUnchanged = areTrackedConflictMapsEqual(
        s.trackedConflictPathsByWorktree[worktreeId] ?? {},
        currentTracked
      )
      const openFilesUnchanged = nextOpenFiles === s.openFiles
      const operationUnchanged = prevOperation === status.conflictOperation

      const prevIgnored = s.gitIgnoredPathsByWorktree[worktreeId]
      const nextIgnored = status.ignoredPaths ?? []
      const ignoredUnchanged =
        prevIgnored !== undefined &&
        prevIgnored.length === nextIgnored.length &&
        prevIgnored.every((p, i) => p === nextIgnored[i])

      const prevHuge = s.gitStatusHugeByWorktree[worktreeId]
      const nextHuge = status.didHitLimit ? { limit: nextEntries.length } : undefined
      const hugeUnchanged = (prevHuge?.limit ?? null) === (nextHuge?.limit ?? null)
      const prevStatusHead = s.gitStatusHeadByWorktree[worktreeId]
      const nextStatusHead = getKnownGitHead(status.head)
      const statusHeadUnchanged = prevStatusHead === nextStatusHead

      const prevBranchSummary = s.gitBranchCompareSummaryByWorktree[worktreeId]
      // Why: a compare request can finish after git status has observed a new
      // HEAD; reject that stale snapshot before it can render a false clean state.
      const shouldInvalidateBranchCompare =
        !statusHeadUnchanged &&
        nextStatusHead !== undefined &&
        prevBranchSummary?.status === 'ready' &&
        !branchCompareMatchesStatusHead(prevBranchSummary, nextStatusHead)

      if (
        statusUnchanged &&
        trackedUnchanged &&
        openFilesUnchanged &&
        operationUnchanged &&
        ignoredUnchanged &&
        hugeUnchanged &&
        statusHeadUnchanged &&
        !shouldInvalidateBranchCompare
      ) {
        return s
      }

      const nextHugeMap = hugeUnchanged
        ? s.gitStatusHugeByWorktree
        : nextHuge
          ? { ...s.gitStatusHugeByWorktree, [worktreeId]: nextHuge }
          : (() => {
              const copy = { ...s.gitStatusHugeByWorktree }
              delete copy[worktreeId]
              return copy
            })()

      const nextStatusHeadMap = statusHeadUnchanged
        ? s.gitStatusHeadByWorktree
        : nextStatusHead
          ? { ...s.gitStatusHeadByWorktree, [worktreeId]: nextStatusHead }
          : (() => {
              const copy = { ...s.gitStatusHeadByWorktree }
              delete copy[worktreeId]
              return copy
            })()
      const nextBranchCompareSummaries = shouldInvalidateBranchCompare
        ? {
            ...s.gitBranchCompareSummaryByWorktree,
            [worktreeId]: createLoadingBranchCompareSummary(prevBranchSummary.baseRef)
          }
        : s.gitBranchCompareSummaryByWorktree
      const nextBranchChanges = shouldInvalidateBranchCompare
        ? { ...s.gitBranchChangesByWorktree, [worktreeId]: [] }
        : s.gitBranchChangesByWorktree

      return {
        openFiles: nextOpenFiles,
        gitStatusHugeByWorktree: nextHugeMap,
        gitStatusHeadByWorktree: nextStatusHeadMap,
        gitStatusByWorktree: statusUnchanged
          ? s.gitStatusByWorktree
          : { ...s.gitStatusByWorktree, [worktreeId]: nextEntries },
        gitIgnoredPathsByWorktree: ignoredUnchanged
          ? s.gitIgnoredPathsByWorktree
          : { ...s.gitIgnoredPathsByWorktree, [worktreeId]: nextIgnored },
        gitConflictOperationByWorktree: operationUnchanged
          ? s.gitConflictOperationByWorktree
          : { ...s.gitConflictOperationByWorktree, [worktreeId]: status.conflictOperation },
        trackedConflictPathsByWorktree: trackedUnchanged
          ? s.trackedConflictPathsByWorktree
          : { ...s.trackedConflictPathsByWorktree, [worktreeId]: currentTracked },
        gitBranchCompareSummaryByWorktree: nextBranchCompareSummaries,
        gitBranchChangesByWorktree: nextBranchChanges
      }
    }),
  setConflictOperation: (worktreeId, operation) =>
    set((s) => {
      const prev = s.gitConflictOperationByWorktree[worktreeId] ?? 'unknown'
      if (prev === operation) {
        return s
      }
      // Why: when the operation clears (transitions to 'unknown') on a non-active
      // worktree, we also need to clear tracked conflict paths — same as the
      // full setGitStatus handler does for the active worktree.
      const nextTracked =
        operation === 'unknown' && prev !== 'unknown'
          ? {}
          : s.trackedConflictPathsByWorktree[worktreeId]
      const trackedUnchanged = nextTracked === s.trackedConflictPathsByWorktree[worktreeId]
      return {
        gitConflictOperationByWorktree: {
          ...s.gitConflictOperationByWorktree,
          [worktreeId]: operation
        },
        ...(trackedUnchanged
          ? {}
          : {
              trackedConflictPathsByWorktree: {
                ...s.trackedConflictPathsByWorktree,
                [worktreeId]: nextTracked
              }
            })
      }
    }),
  remoteStatusesByWorktree: {},
  setUpstreamStatus: (worktreeId, status) =>
    set((s) => {
      if (areUpstreamStatusesEqual(s.remoteStatusesByWorktree[worktreeId], status)) {
        return s
      }
      return {
        remoteStatusesByWorktree: {
          ...s.remoteStatusesByWorktree,
          [worktreeId]: status
        }
      }
    }),
  isRemoteOperationActive: false,
  remoteOperationDepth: 0,
  inFlightRemoteOpKind: null,
  beginRemoteOperation: (kind) =>
    set((s) => ({
      remoteOperationDepth: s.remoteOperationDepth + 1,
      isRemoteOperationActive: true,
      // Why: last-write-wins. The UI disables every action entry while busy,
      // so a second remote op can't be started from inside Orca. If a
      // background caller (future) triggers one, surfacing the most recent
      // kind matches "what the user is currently watching".
      inFlightRemoteOpKind: kind ?? s.inFlightRemoteOpKind
    })),
  endRemoteOperation: () =>
    set((s) => {
      const next = Math.max(0, s.remoteOperationDepth - 1)
      return {
        remoteOperationDepth: next,
        isRemoteOperationActive: next > 0,
        // Why: only clear the in-flight kind when no remote op remains. Until
        // depth reaches 0 some other op is still running and its label/
        // spinner should keep displaying.
        inFlightRemoteOpKind: next > 0 ? s.inFlightRemoteOpKind : null
      }
    }),
  fetchUpstreamStatus: async (worktreeId, worktreePath, connectionId, pushTarget, options) => {
    const runtimeSettings = options?.runtimeTargetSettings ?? get().settings
    try {
      const status = await getRuntimeGitUpstreamStatus(
        {
          settings: runtimeSettings,
          worktreeId,
          worktreePath,
          connectionId
        },
        pushTarget
      )
      if (options?.applyUpstreamStatus !== false) {
        get().setUpstreamStatus(worktreeId, status)
      }
      return status
    } catch (error) {
      // Why: on error we leave the prior status in place rather than writing a
      // synthetic {hasUpstream:false} — that would flash 'Publish Branch' on a
      // tracked branch after any transient IPC hiccup and a user click would
      // re-publish, clobbering the upstream relationship. If the branch is
      // genuinely newly unpublished, the polling effect will eventually correct
      // the status on success.
      if (pushTarget) {
        // Why: an old automatic poll cache entry must not suppress the next
        // retry after a post-push/fetch refresh fails transiently.
        invalidateAutomaticPushTargetUpstreamStatusCache({
          settings: runtimeSettings,
          worktreeId,
          worktreePath,
          connectionId,
          pushTarget
        })
      }
      console.error('fetchUpstreamStatus failed', error)
      return null
    }
  },
  pushBranch: async (
    worktreeId,
    worktreePath,
    publish = false,
    connectionId,
    pushTarget,
    options = {}
  ) => {
    // Why: don't *await* a post-op git status / upstream refresh here.
    // Chaining awaited refreshes inside the mutation extends the gap before
    // compound flows (runCompoundCommitAction → runRemoteAction) reach the
    // next step. But we still need a near-immediate upstream refresh so
    // the primary button label rotates from "Push" to "Commit" as soon as
    // ahead=0 — the polling layer is on a 3s interval, which is long
    // enough to read as a stuck label. Solution: fire the upstream refresh
    // as fire-and-forget so it doesn't block the mutation but updates the
    // store as soon as the IPC resolves.
    get().beginRemoteOperation(
      publish ? 'publish' : options.forceWithLease === true ? 'force_push' : 'push'
    )
    let shouldRefreshAfterRejectedPush = false
    const runtimeSettings = options.runtimeTargetSettings ?? get().settings
    try {
      await pushRuntimeGit(
        { settings: runtimeSettings, worktreeId, worktreePath, connectionId },
        { publish, pushTarget, forceWithLease: options.forceWithLease }
      )
    } catch (error) {
      shouldRefreshAfterRejectedPush = isNonFastForwardRemoteError(error)
      toast.error(
        resolveRemoteOperationErrorMessage(error, {
          publish,
          isPush: !publish && options.forceWithLease !== true,
          isForcePush: !publish && options.forceWithLease === true
        })
      )
      throw error
    } finally {
      get().endRemoteOperation()
      if (shouldRefreshAfterRejectedPush) {
        const context = { settings: runtimeSettings, worktreeId, worktreePath, connectionId }
        // Why: the rejected push proved the publish branch moved. Fetch first
        // so legacy base-tracking worktrees can discover origin/<branch>, then
        // refresh ahead/behind so Pull/Sync become actionable immediately.
        void fetchRuntimeGit(context, pushTarget)
          .catch(() => undefined)
          .then(() =>
            get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId, pushTarget, {
              runtimeTargetSettings: runtimeSettings
            })
          )
      }
    }
    void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId, pushTarget, {
      runtimeTargetSettings: runtimeSettings
    })
    const refreshGitHubForWorktree = get().refreshGitHubForWorktree
    if (typeof refreshGitHubForWorktree === 'function') {
      refreshGitHubForWorktree(worktreeId)
    }
  },
  pullBranch: async (worktreeId, worktreePath, connectionId, pushTarget, options) => {
    get().beginRemoteOperation('pull')
    const runtimeSettings = options?.runtimeTargetSettings ?? get().settings
    try {
      await pullRuntimeGit(
        { settings: runtimeSettings, worktreeId, worktreePath, connectionId },
        pushTarget
      )
    } catch (error) {
      toast.error(resolveRemoteOperationErrorMessage(error))
      throw error
    } finally {
      get().endRemoteOperation()
    }
    void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId, pushTarget, {
      runtimeTargetSettings: runtimeSettings
    })
    const refreshGitHubForWorktree = get().refreshGitHubForWorktree
    if (typeof refreshGitHubForWorktree === 'function') {
      refreshGitHubForWorktree(worktreeId)
    }
  },
  fastForwardBranch: async (worktreeId, worktreePath, connectionId, pushTarget, options) => {
    get().beginRemoteOperation('fast_forward')
    const runtimeSettings = options?.runtimeTargetSettings ?? get().settings
    try {
      await fastForwardRuntimeGit(
        { settings: runtimeSettings, worktreeId, worktreePath, connectionId },
        pushTarget
      )
    } catch (error) {
      toast.error(resolveRemoteOperationErrorMessage(error, { isFastForward: true }))
      throw error
    } finally {
      get().endRemoteOperation()
    }
    void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId, pushTarget, {
      runtimeTargetSettings: runtimeSettings
    })
    const refreshGitHubForWorktree = get().refreshGitHubForWorktree
    if (typeof refreshGitHubForWorktree === 'function') {
      refreshGitHubForWorktree(worktreeId)
    }
  },
  syncBranch: async (worktreeId, worktreePath, connectionId, pushTarget, options) => {
    // Why: same shape as pushBranch / pullBranch — fire-and-forget the
    // post-op upstream refresh after the busy flag clears so the primary
    // button label rotates immediately when the IPC resolves.
    get().beginRemoteOperation('sync')
    // Why: the inner push stage toasts with { isSync: true } so its failure
    // surfaces a "Sync failed..." message instead of "Push failed..." — the
    // user invoked Sync; the underlying push is implementation detail. The
    // outer catch must then skip toasting to avoid a double-toast.
    let pushStageToastShown = false
    let pushed = false
    const runtimeSettings = options?.runtimeTargetSettings ?? get().settings
    try {
      const context = { settings: runtimeSettings, worktreeId, worktreePath, connectionId }
      await fetchRuntimeGit(context, pushTarget)
      const upstreamStatusBeforePull = await getRuntimeGitUpstreamStatus(context, pushTarget)
      if (shouldForcePushWithLeaseForUpstream(upstreamStatusBeforePull)) {
        try {
          await pushRuntimeGit(context, { pushTarget, forceWithLease: true })
          pushed = true
        } catch (error) {
          toast.error(resolveRemoteOperationErrorMessage(error, { isSync: true }))
          pushStageToastShown = true
          throw error
        }
      } else {
        await pullRuntimeGit(context, pushTarget)
        // Why: push only if the pull left local commits that aren't on the
        // remote. After a merge pull the ahead count can be >0 (local commits +
        // the new merge commit) or 0 (pure fast-forward), and we avoid a
        // no-op push round-trip in the fast-forward case.
        const upstreamStatus = await getRuntimeGitUpstreamStatus(context, pushTarget)
        if (upstreamStatus.ahead > 0) {
          try {
            await pushRuntimeGit(context, { pushTarget })
            pushed = true
          } catch (error) {
            // Why: format under the user-facing operation (sync) rather than
            // the inner step (push) — the user clicked Sync and shouldn't see
            // a "Push failed" toast for a step they didn't directly invoke.
            toast.error(resolveRemoteOperationErrorMessage(error, { isSync: true }))
            pushStageToastShown = true
            throw error
          }
        }
      }
    } catch (error) {
      if (!pushStageToastShown) {
        // Why: same isSync framing for fetch/pull/upstream-status failures so
        // every sync failure path consistently reads as "Sync failed..." (or
        // a more specific actionable message like "Pull blocked..." when the
        // shared classifiers match first).
        toast.error(resolveRemoteOperationErrorMessage(error, { isSync: true }))
      }
      throw error
    } finally {
      get().endRemoteOperation()
    }
    void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId, pushTarget, {
      runtimeTargetSettings: runtimeSettings
    })
    if (pushed) {
      const refreshGitHubForWorktree = get().refreshGitHubForWorktree
      if (typeof refreshGitHubForWorktree === 'function') {
        refreshGitHubForWorktree(worktreeId)
      }
    }
  },
  rebaseFromBase: async (worktreeId, worktreePath, baseRef, connectionId, pushTarget, options) => {
    get().beginRemoteOperation('rebase')
    const runtimeSettings = options?.runtimeTargetSettings ?? get().settings
    try {
      await rebaseRuntimeGitFromBase(
        { settings: runtimeSettings, worktreeId, worktreePath, connectionId },
        baseRef
      )
    } catch (error) {
      toast.error(resolveRemoteOperationErrorMessage(error, { isRebase: true }))
      throw error
    } finally {
      get().endRemoteOperation()
    }
    void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId, pushTarget, {
      runtimeTargetSettings: runtimeSettings
    })
    const refreshGitHubForWorktree = get().refreshGitHubForWorktree
    if (typeof refreshGitHubForWorktree === 'function') {
      refreshGitHubForWorktree(worktreeId)
    }
  },
  fetchBranch: async (worktreeId, worktreePath, connectionId, pushTarget, options) => {
    // Why: same shape as pushBranch / pullBranch — fire-and-forget the
    // upstream refresh after the busy flag clears. Fetch updates the
    // remote refs only, so the visible signal we want is the new
    // ahead/behind counts on the upstream-status payload.
    get().beginRemoteOperation('fetch')
    const runtimeSettings = options?.runtimeTargetSettings ?? get().settings
    try {
      await fetchRuntimeGit(
        { settings: runtimeSettings, worktreeId, worktreePath, connectionId },
        pushTarget
      )
    } catch (error) {
      toast.error(resolveRemoteOperationErrorMessage(error, { isFetch: true }))
      throw error
    } finally {
      get().endRemoteOperation()
    }
    void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId, pushTarget, {
      runtimeTargetSettings: runtimeSettings
    })
  },
  gitBranchChangesByWorktree: {},
  gitBranchCompareSummaryByWorktree: {},
  gitBranchCompareRequestKeyByWorktree: {},
  gitBranchCompareRequestStatusHeadByWorktree: {},
  beginGitBranchCompareRequest: (worktreeId, requestKey, baseRef, options) =>
    set((s) => ({
      gitBranchCompareRequestKeyByWorktree: {
        ...s.gitBranchCompareRequestKeyByWorktree,
        [worktreeId]: requestKey
      },
      gitBranchCompareRequestStatusHeadByWorktree: {
        ...s.gitBranchCompareRequestStatusHeadByWorktree,
        [worktreeId]: getKnownGitHead(s.gitStatusHeadByWorktree[worktreeId]) ?? null
      },
      ...(options?.preserveExistingSummary
        ? {}
        : {
            gitBranchCompareSummaryByWorktree: {
              ...s.gitBranchCompareSummaryByWorktree,
              [worktreeId]: createLoadingBranchCompareSummary(baseRef)
            }
          })
    })),
  setGitBranchCompareResult: (worktreeId, requestKey, result) =>
    set((s) => {
      if (s.gitBranchCompareRequestKeyByWorktree[worktreeId] !== requestKey) {
        return s
      }
      const statusHead = getKnownGitHead(s.gitStatusHeadByWorktree[worktreeId])
      const requestStatusHead = s.gitBranchCompareRequestStatusHeadByWorktree[worktreeId]
      // Why: polling refreshes can leave the prior UI visible while a compare
      // request is in flight; never let a pre-status-change result overwrite
      // a newer status snapshot.
      if (
        result.summary.status !== 'loading' &&
        statusHead !== undefined &&
        requestStatusHead !== statusHead &&
        !branchCompareMatchesStatusHead(result.summary, statusHead)
      ) {
        return s
      }
      const prevEntries = s.gitBranchChangesByWorktree[worktreeId]
      const prevSummary = s.gitBranchCompareSummaryByWorktree[worktreeId]
      const entriesUnchanged =
        prevEntries &&
        prevEntries.length === result.entries.length &&
        prevEntries.every(
          (e, i) =>
            e.path === result.entries[i].path &&
            e.status === result.entries[i].status &&
            e.oldPath === result.entries[i].oldPath
        )
      const summaryUnchanged =
        prevSummary &&
        prevSummary.status === result.summary.status &&
        prevSummary.baseOid === result.summary.baseOid &&
        prevSummary.headOid === result.summary.headOid &&
        prevSummary.changedFiles === result.summary.changedFiles
      if (entriesUnchanged && summaryUnchanged) {
        return s
      }
      return {
        gitBranchChangesByWorktree: entriesUnchanged
          ? s.gitBranchChangesByWorktree
          : { ...s.gitBranchChangesByWorktree, [worktreeId]: result.entries },
        gitBranchCompareSummaryByWorktree: summaryUnchanged
          ? s.gitBranchCompareSummaryByWorktree
          : { ...s.gitBranchCompareSummaryByWorktree, [worktreeId]: result.summary }
      }
    }),
  // Why: when the compare base resolves to "no base" (e.g. the prefer-upstream
  // setting is on and the branch has no upstream), drop any stale summary so the
  // committed-changes section and "vs" row disappear instead of lingering.
  clearGitBranchCompare: (worktreeId) =>
    set((s) => {
      if (
        s.gitBranchCompareSummaryByWorktree[worktreeId] === undefined &&
        s.gitBranchChangesByWorktree[worktreeId] === undefined &&
        s.gitBranchCompareRequestKeyByWorktree[worktreeId] === undefined &&
        s.gitBranchCompareRequestStatusHeadByWorktree[worktreeId] === undefined
      ) {
        return s
      }
      const nextSummary = { ...s.gitBranchCompareSummaryByWorktree }
      const nextChanges = { ...s.gitBranchChangesByWorktree }
      const nextRequestKey = { ...s.gitBranchCompareRequestKeyByWorktree }
      const nextRequestHead = { ...s.gitBranchCompareRequestStatusHeadByWorktree }
      delete nextSummary[worktreeId]
      delete nextChanges[worktreeId]
      delete nextRequestKey[worktreeId]
      delete nextRequestHead[worktreeId]
      return {
        gitBranchCompareSummaryByWorktree: nextSummary,
        gitBranchChangesByWorktree: nextChanges,
        gitBranchCompareRequestKeyByWorktree: nextRequestKey,
        gitBranchCompareRequestStatusHeadByWorktree: nextRequestHead
      }
    }),

  // File search
  fileSearchStateByWorktree: {},
  updateFileSearchState: (worktreeId, updates) =>
    set((s) => {
      const current = s.fileSearchStateByWorktree[worktreeId] || defaultFileSearchState()
      return {
        fileSearchStateByWorktree: {
          ...s.fileSearchStateByWorktree,
          [worktreeId]: { ...current, ...updates }
        }
      }
    }),
  seedFileSearchQuery: (worktreeId, query) =>
    set((s) => {
      const current = s.fileSearchStateByWorktree[worktreeId] || defaultFileSearchState()
      return {
        fileSearchStateByWorktree: {
          ...s.fileSearchStateByWorktree,
          [worktreeId]: {
            ...current,
            query,
            results: null,
            loading: false,
            collapsedFiles: new Set(),
            seedRequestId: (current.seedRequestId ?? 0) + 1
          }
        }
      }
    }),
  seedFileSearchIncludePattern: (worktreeId, includePattern) =>
    set((s) => {
      const current = s.fileSearchStateByWorktree[worktreeId] || defaultFileSearchState()
      return {
        fileSearchStateByWorktree: {
          ...s.fileSearchStateByWorktree,
          [worktreeId]: {
            ...current,
            includePattern,
            results: null,
            loading: false,
            collapsedFiles: new Set(),
            seedRequestId: (current.seedRequestId ?? 0) + 1
          }
        }
      }
    }),
  consumeFileSearchSeedRequest: (worktreeId, seedRequestId) =>
    set((s) => {
      const current = s.fileSearchStateByWorktree[worktreeId]
      if (!current || current.seedRequestId !== seedRequestId) {
        return s
      }
      const next = { ...current }
      delete next.seedRequestId
      return {
        fileSearchStateByWorktree: {
          ...s.fileSearchStateByWorktree,
          [worktreeId]: next
        }
      }
    }),
  toggleFileSearchCollapsedFile: (worktreeId, filePath) =>
    set((s) => {
      const current = s.fileSearchStateByWorktree[worktreeId]
      if (!current) {
        return s
      }
      const nextCollapsed = new Set(current.collapsedFiles)
      if (nextCollapsed.has(filePath)) {
        nextCollapsed.delete(filePath)
      } else {
        nextCollapsed.add(filePath)
      }
      return {
        fileSearchStateByWorktree: {
          ...s.fileSearchStateByWorktree,
          [worktreeId]: { ...current, collapsedFiles: nextCollapsed }
        }
      }
    }),
  clearFileSearch: (worktreeId) =>
    set((s) => {
      const current = s.fileSearchStateByWorktree[worktreeId]
      if (!current) {
        return s
      }
      return {
        fileSearchStateByWorktree: {
          ...s.fileSearchStateByWorktree,
          [worktreeId]: {
            ...current,
            query: '',
            results: null,
            loading: false,
            collapsedFiles: new Set()
          }
        }
      }
    }),

  // Editor navigation
  pendingEditorReveal: null,
  setPendingEditorReveal: (reveal) => set({ pendingEditorReveal: reveal }),

  activateMarkdownLink: async (rawHref, ctx) => {
    const initialState = get()
    const sourceRuntimeEnvironmentId =
      ctx.runtimeEnvironmentId !== undefined
        ? ctx.runtimeEnvironmentId
        : initialState.openFiles.find((file) => file.filePath === ctx.sourceFilePath)
            ?.runtimeEnvironmentId
    const sourceSettings = settingsForRuntimeOwner(
      initialState.settings,
      sourceRuntimeEnvironmentId
    )
    const sourceConnectionId = getWorktreeConnectionId(initialState, ctx.worktreeId)
    const fileContext = {
      settings: sourceSettings,
      worktreeId: ctx.worktreeId,
      worktreePath: ctx.worktreeRoot,
      connectionId: sourceConnectionId
    }
    const target = resolveMarkdownLinkTarget(rawHref, ctx.sourceFilePath, ctx.worktreeRoot)
    if (!target) {
      return
    }
    if (target.kind === 'anchor') {
      return
    }
    if (target.kind === 'external') {
      openHttpLink(target.url, { worktreeId: ctx.worktreeId })
      return
    }
    if (target.kind === 'file') {
      const { line, column } = target
      if (target.relativePath === undefined) {
        if (isLocalPathOpenBlocked(sourceSettings, { connectionId: sourceConnectionId })) {
          // Why: a file:// link outside the worktree is a client-local escape
          // hatch. Remote runtime/SSH editors must not treat server paths as client paths.
          showLocalPathOpenBlockedToast()
          return
        }
        // Why: terminal file links already authorize clicked external paths
        // before opening them in Orca. Markdown file:// links need the same
        // user-gesture authorization so /tmp screenshots can use ImageViewer.
        await window.api.fs.authorizeExternalPath({ targetPath: target.absolutePath })
      } else {
        let stats: { isDirectory: boolean }
        try {
          stats = await statRuntimePath(fileContext, target.absolutePath)
        } catch {
          toast.error(
            translate('auto.store.slices.editor.f2e00db373', 'File not found: {{value0}}', {
              value0: target.relativePath
            })
          )
          return
        }
        if (stats.isDirectory) {
          toast.error(
            translate('auto.store.slices.editor.51f15c37d3', 'Cannot open directory: {{value0}}', {
              value0: target.relativePath
            })
          )
          return
        }
      }

      get().openFile(
        {
          filePath: target.absolutePath,
          relativePath: target.relativePath ?? target.absolutePath,
          worktreeId: ctx.worktreeId,
          runtimeEnvironmentId: sourceRuntimeEnvironmentId,
          language: detectLanguage(target.absolutePath),
          mode: 'edit'
        },
        {
          preview: true,
          targetGroupId: get().activeGroupIdByWorktree?.[ctx.worktreeId],
          recordReplacedPreview: true
        }
      )
      if (line !== undefined) {
        const fileId = getOpenedEditFileIdAfterOpen(get(), target.absolutePath, ctx.worktreeId)
        scheduleEditorLineReveal(get, target.absolutePath, line, column, fileId)
      }
      return
    }

    // target.kind === 'markdown'
    const { absolutePath, relativePath, line, column } = target
    let stats: { isDirectory: boolean }
    try {
      stats = await statRuntimePath(fileContext, absolutePath)
    } catch {
      toast.error(
        translate('auto.store.slices.editor.f2e00db373', 'File not found: {{value0}}', {
          value0: relativePath
        })
      )
      return
    }
    if (stats.isDirectory) {
      toast.error(
        translate('auto.store.slices.editor.51f15c37d3', 'Cannot open directory: {{value0}}', {
          value0: relativePath
        })
      )
      return
    }

    get().openFile(
      {
        filePath: absolutePath,
        relativePath,
        worktreeId: ctx.worktreeId,
        runtimeEnvironmentId: sourceRuntimeEnvironmentId,
        language: 'markdown',
        mode: 'edit'
      },
      {
        preview: true,
        targetGroupId: get().activeGroupIdByWorktree?.[ctx.worktreeId],
        recordReplacedPreview: true
      }
    )

    if (line !== undefined) {
      const fileId = getOpenedEditFileIdAfterOpen(get(), absolutePath, ctx.worktreeId)
      // Why: pendingEditorReveal is consumed by MonacoEditor on mount. If the
      // file stays in rich mode, the reveal is silently dropped; use the final
      // owner-qualified id after openFile has resolved the tab identity.
      get().setMarkdownViewMode(fileId, 'source')
      scheduleEditorLineReveal(get, absolutePath, line, column, fileId)
    }
  },

  // Why: only edit-mode files are restored — diffs and conflict views depend on
  // transient git state that may have changed between sessions. Restoring them
  // would show stale data or fail to load entirely.
  hydrateEditorSession: (session, options) => {
    set((s) => {
      const openFilesByWorktree = session.openFilesByWorktree ?? {}
      const persistedActiveFileIdByWorktree = session.activeFileIdByWorktree ?? {}
      const persistedActiveTabTypeByWorktree = session.activeTabTypeByWorktree ?? {}
      const persistedMarkdownFrontmatterVisible = session.markdownFrontmatterVisible ?? {}

      // Why: worktrees may have been deleted between sessions. Filter out
      // files for worktrees that no longer exist, mirroring the validation
      // that hydrateWorkspaceSession performs for terminal tabs.
      const validWorktreeIds = new Set(
        Object.values(s.worktreesByRepo)
          .flat()
          .map((w) => w.id)
      )
      validWorktreeIds.add(FLOATING_TERMINAL_WORKTREE_ID)
      for (const workspace of s.folderWorkspaces) {
        validWorktreeIds.add(folderWorkspaceKey(workspace.id))
      }
      addAdditionalValidWorkspaceKeys(validWorktreeIds, options)

      const openFiles: OpenFile[] = []
      const editorDrafts: Record<string, string> = {}
      const usedOpenFileIds = new Set<string>()
      const legacyHydratedOpenFiles: LegacyHydratedEditorFile[] = []
      const editorFileIdMigrationsByWorktree: Record<string, Map<string, string>> = {}
      for (const [worktreeId, files] of Object.entries(openFilesByWorktree)) {
        if (!validWorktreeIds.has(worktreeId)) {
          continue
        }
        for (const pf of files) {
          const legacyId = resolveLegacyHydratedEditorFileId(
            legacyHydratedOpenFiles,
            pf,
            worktreeId
          )
          // Why: floating/runtime-owned files need IDs that survive peers
          // disappearing between restarts; collision-based IDs drift when the
          // same path is no longer open in another owner.
          const ownedId = buildOwnedEditorFileId(pf.filePath, worktreeId, pf.runtimeEnvironmentId)
          const id =
            shouldHydrateWithOwnedEditorFileId(worktreeId, pf.runtimeEnvironmentId) ||
            usedOpenFileIds.has(pf.filePath)
              ? ownedId
              : pf.filePath
          usedOpenFileIds.add(id)
          // Why: legacy sessions used the collision-derived id for each
          // persisted entry. Mapping every filePath would collapse same-path
          // local/runtime tabs onto whichever owner hydrates last.
          addEditorFileIdMigration(editorFileIdMigrationsByWorktree, worktreeId, legacyId, id)
          legacyHydratedOpenFiles.push({
            id: legacyId,
            filePath: pf.filePath,
            worktreeId,
            runtimeEnvironmentId: pf.runtimeEnvironmentId
          })
          if (pf.dirtyDraftContent !== undefined) {
            editorDrafts[id] = pf.dirtyDraftContent
          }
          openFiles.push({
            id,
            filePath: pf.filePath,
            relativePath: pf.relativePath,
            worktreeId,
            // Why: sessions can contain language ids from older Orca builds.
            // Re-detect on hydrate so newly-supported extensions like .ipynb
            // stop reopening as raw JSON/plain text after the upgrade.
            language: detectLanguage(pf.relativePath || pf.filePath),
            isDirty: pf.dirtyDraftContent !== undefined,
            isPreview: pf.isPreview,
            runtimeEnvironmentId: pf.runtimeEnvironmentId,
            mode: 'edit'
          })
        }
      }

      // Why: use the store's activeWorktreeId (set by hydrateWorkspaceSession)
      // rather than the raw session value. hydrateWorkspaceSession may have
      // nulled out an invalid worktree ID, and we must respect that decision.
      const activeWorktreeId = s.activeWorktreeId
      const fallbackActiveFileId = activeWorktreeId
        ? (openFiles.find((f) => f.worktreeId === activeWorktreeId)?.id ?? null)
        : null
      const persistedActiveFileId = activeWorktreeId
        ? migrateEditorFileId(
            editorFileIdMigrationsByWorktree,
            activeWorktreeId,
            persistedActiveFileIdByWorktree[activeWorktreeId]
          )
        : null
      // Why: verify the persisted active file still exists in the restored set.
      // The file may have been removed due to worktree validation or the
      // persisted data may reference a stale path.
      const activeFileExists = persistedActiveFileId
        ? openFiles.some((f) => f.id === persistedActiveFileId && f.worktreeId === activeWorktreeId)
        : false
      // Why: if the previously active editor surface pointed at a transient
      // diff/conflict tab, restart still restores any normal edit tabs for the
      // worktree. Promote the first restored edit file so the UI comes back on
      // a concrete file tab instead of an unselected editor surface.
      const nextActiveFileId = activeFileExists ? persistedActiveFileId : fallbackActiveFileId
      const activeTabType: WorkspaceVisibleTabType =
        activeWorktreeId && persistedActiveTabTypeByWorktree[activeWorktreeId]
          ? persistedActiveTabTypeByWorktree[activeWorktreeId]
          : 'terminal'

      // Filter per-worktree maps to only valid worktrees with valid file references
      const filteredActiveFileIdByWorktree = Object.fromEntries(
        [...validWorktreeIds].flatMap((wId) => {
          const persistedFileId = migrateEditorFileId(
            editorFileIdMigrationsByWorktree,
            wId,
            persistedActiveFileIdByWorktree[wId]
          )
          if (
            persistedFileId &&
            openFiles.some((f) => f.id === persistedFileId && f.worktreeId === wId)
          ) {
            return [[wId, persistedFileId]]
          }
          const fallbackFileId = openFiles.find((f) => f.worktreeId === wId)?.id
          return fallbackFileId ? [[wId, fallbackFileId]] : []
        })
      )
      const filteredActiveTabTypeByWorktree = Object.fromEntries(
        Object.entries(persistedActiveTabTypeByWorktree).filter(([wId, tabType]) => {
          if (!validWorktreeIds.has(wId)) {
            return false
          }
          if (tabType !== 'editor') {
            return true
          }
          // Why: a persisted "editor" surface only makes sense if that
          // worktree still restored a concrete active editor file. Otherwise we
          // preserve a stale last-active marker that conflicts with browser or
          // terminal restore logic for the same worktree.
          return Boolean(filteredActiveFileIdByWorktree[wId])
        })
      )

      // Why: restart only restores edit-mode files. If the previous active
      // surface for the current worktree was a transient diff/conflict view,
      // we must clear the stale "editor" marker here so startup falls back to
      // browser or terminal instead of showing an empty editor surface.
      const nextActiveTabType =
        nextActiveFileId || activeTabType !== 'editor' ? activeTabType : 'terminal'
      const openFileIds = new Set(openFiles.map((file) => file.id))
      const visibleFrontmatterEntries = new Map<string, boolean>()
      for (const [persistedFileId, visible] of Object.entries(
        persistedMarkdownFrontmatterVisible
      )) {
        if (!visible) {
          continue
        }
        if (openFileIds.has(persistedFileId)) {
          visibleFrontmatterEntries.set(persistedFileId, true)
        }
        for (const migrations of Object.values(editorFileIdMigrationsByWorktree)) {
          const migratedFileId = migrations.get(persistedFileId)
          if (migratedFileId && openFileIds.has(migratedFileId)) {
            visibleFrontmatterEntries.set(migratedFileId, true)
          }
        }
      }
      const markdownFrontmatterVisible = Object.fromEntries(visibleFrontmatterEntries)

      return {
        openFiles,
        editorDrafts,
        markdownFrontmatterVisible,
        activeFileId: nextActiveFileId,
        activeFileIdByWorktree: filteredActiveFileIdByWorktree,
        activeTabType: nextActiveTabType,
        activeTabTypeByWorktree: filteredActiveTabTypeByWorktree,
        ...migrateHydratedEditorTabsAndGroups(s, editorFileIdMigrationsByWorktree)
      }
    })
  }
})

function getCompareVersion(
  compare: Pick<BranchCompareLike, 'baseOid' | 'headOid' | 'mergeBase'>
): string {
  return [
    compare.baseOid ?? 'no-base',
    compare.headOid ?? 'no-head',
    compare.mergeBase ?? 'no-merge-base'
  ].join(':')
}

function toBranchCompareSnapshot(compare: BranchCompareLike): BranchCompareSnapshot {
  return {
    baseRef: compare.baseRef,
    baseOid: compare.baseOid,
    compareRef: compare.compareRef,
    headOid: compare.headOid,
    mergeBase: compare.mergeBase,
    compareVersion: getCompareVersion(compare)
  }
}

function toCommitCompareSnapshot(
  compare: CommitCompareLike,
  subject?: string,
  message?: string
): CommitCompareSnapshot {
  return {
    commitOid: compare.commitOid,
    parentOid: compare.parentOid,
    compareRef: compare.compareRef,
    baseRef: compare.baseRef,
    compareVersion: `${compare.parentOid ?? 'empty-tree'}:${compare.commitOid}`,
    subject:
      subject ??
      ('subject' in compare && typeof compare.subject === 'string' ? compare.subject : undefined),
    message:
      message ??
      ('message' in compare && typeof compare.message === 'string' ? compare.message : undefined)
  }
}

function toOpenConflictMetadata(entry: GitStatusEntry): OpenConflictMetadata | undefined {
  if (!entry.conflictKind || !entry.conflictStatus || !entry.conflictStatusSource) {
    return undefined
  }

  const hasWorkingTreeFile = entry.status !== 'deleted'
  return hasWorkingTreeFile
    ? {
        kind: 'conflict-editable',
        conflictKind: entry.conflictKind,
        conflictStatus: entry.conflictStatus,
        conflictStatusSource: entry.conflictStatusSource
      }
    : {
        kind: 'conflict-placeholder',
        conflictKind: entry.conflictKind,
        conflictStatus: entry.conflictStatus,
        conflictStatusSource: entry.conflictStatusSource,
        message: translate(
          'auto.store.slices.editor.dcb521ed29',
          'This file is in a conflict state, but no working-tree file is available to edit.'
        ),
        guidance: 'Resolve the conflict in Git or restore one side before reopening it.'
      }
}

// Why: equality checks comparing only path/status/area are insufficient. A row
// can change from unresolved to resolved_locally (or vice versa) without its
// base GitFileStatus changing. Without checking conflictKind, conflictStatus,
// and conflictStatusSource here, the affected row would remain visually stale.
function areGitStatusEntriesEqual(prev: GitStatusEntry[], next: GitStatusEntry[]): boolean {
  return (
    prev.length === next.length &&
    prev.every(
      (entry, index) =>
        entry.path === next[index].path &&
        entry.status === next[index].status &&
        entry.area === next[index].area &&
        entry.oldPath === next[index].oldPath &&
        entry.conflictKind === next[index].conflictKind &&
        entry.conflictStatus === next[index].conflictStatus &&
        entry.conflictStatusSource === next[index].conflictStatusSource &&
        entry.added === next[index].added &&
        entry.removed === next[index].removed
    )
  )
}

function areTrackedConflictMapsEqual(
  prev: Record<string, GitConflictKind>,
  next: Record<string, GitConflictKind>
): boolean {
  const prevKeys = Object.keys(prev)
  const nextKeys = Object.keys(next)
  return prevKeys.length === nextKeys.length && prevKeys.every((key) => prev[key] === next[key])
}

function areUpstreamStatusesEqual(
  prev: GitUpstreamStatus | undefined,
  next: GitUpstreamStatus
): boolean {
  return (
    prev !== undefined &&
    prev.hasUpstream === next.hasUpstream &&
    prev.upstreamName === next.upstreamName &&
    prev.ahead === next.ahead &&
    prev.behind === next.behind &&
    prev.hasConfiguredPushTarget === next.hasConfiguredPushTarget &&
    prev.behindCommitsArePatchEquivalent === next.behindCommitsArePatchEquivalent
  )
}

function reconcileOpenFilesForStatus(
  openFiles: OpenFile[],
  worktreeId: string,
  nextEntries: GitStatusEntry[]
): OpenFile[] {
  const entriesByPath = new Map(nextEntries.map((entry) => [entry.path, entry]))
  let changed = false

  const nextOpenFiles = openFiles.flatMap((file) => {
    if (file.worktreeId !== worktreeId) {
      return [file]
    }

    if (file.mode === 'conflict-review' || file.mode === 'check-details') {
      return [file]
    }

    const entry = entriesByPath.get(file.relativePath)
    if (!file.conflict) {
      return [file]
    }

    if (!entry || !entry.conflictKind || !entry.conflictStatus || !entry.conflictStatusSource) {
      changed = true
      return file.conflict.kind === 'conflict-placeholder' ? [] : [{ ...file, conflict: undefined }]
    }

    const nextConflict = toOpenConflictMetadata(entry)
    if (!nextConflict) {
      return [file]
    }

    if (
      file.conflict.kind === nextConflict.kind &&
      file.conflict.conflictKind === nextConflict.conflictKind &&
      file.conflict.conflictStatus === nextConflict.conflictStatus &&
      file.conflict.conflictStatusSource === nextConflict.conflictStatusSource &&
      file.conflict.message === nextConflict.message &&
      file.conflict.guidance === nextConflict.guidance
    ) {
      return [file]
    }

    changed = true
    return [{ ...file, conflict: nextConflict }]
  })

  return changed ? nextOpenFiles : openFiles
}
