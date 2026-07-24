/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { pushRecentlyClosedTabKind } from './recently-closed-tabs'
import { joinPath } from '@/lib/path'
import { toast } from 'sonner'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { resolveMarkdownLinkTarget } from '@/components/editor/markdown-internal-links'
import {
  buildCheckRunDetailsTabId,
  getCheckRunDetailsTabLabel,
  type OpenCheckRunDetailsState
} from '@/components/editor/check-run-details-tab'
import { openHttpLink, type HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
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
  markSyncPushStageError,
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
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  addAdditionalValidWorkspaceKeys,
  type WorkspaceSessionHydrationOptions
} from '@/lib/workspace-session-hydration-keys'
import { buildValidWorktreeIdsForSessionHydration } from './degraded-repo-worktree-validity'
import { createUntitledMarkdownFileWithTemplateSelection } from '@/lib/create-untitled-markdown'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'
import type { FileSearchResultOwner } from '@/lib/file-search-result-owner'
import type { EditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext
} from '@/lib/editor-file-operation-owner'

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
  resultOwner: null,
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
  // Why: git status reports '(initial)' for unborn branches; branch compare represents that same state as a null headOid.
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

// OpenFile is one type (not a `mode` union); consumers reading `filePath` must check `mode` first — conflict-review tabs use the worktree root, not a real file.
// `skippedConflicts` lives on the tab so the combined-diff exclusion notice stays stable; live status changing between polls would make it flicker.
// `branchEntriesSnapshot` keeps a combined-branch tab's file list known after switching away from an inactive worktree whose compare data is stale.
export type OpenFile = {
  id: string // use filePath as unique key
  filePath: string // absolute path
  relativePath: string // relative to worktree root
  worktreeId: string
  language: string
  isDirty: boolean
  // Why: remote untitled cleanup must target the creating environment even if the user later switches runtime.
  runtimeEnvironmentId?: string | null
  /** Host provenance captured when the tab opened; mutations reject replacement owners. */
  operationProvenance?: EditorFileOperationProvenance
  /** Why: preview tabs mirror a source file's live draft; storing its ID lets the preview follow unsaved edits without becoming editable. */
  markdownPreviewSourceFileId?: string
  /** Hash fragment to reveal when a preview tab opens from a link (`./guide.md#setup`); kept on tab state so repeat opens can retarget it. */
  markdownPreviewAnchor?: string
  diffSource?: DiffSource
  branchCompare?: BranchCompareSnapshot
  commitCompare?: CommitCompareSnapshot
  branchOldPath?: string
  combinedAlternate?: CombinedDiffAlternate
  combinedAreaFilter?: string // filter combined diff to a specific area (e.g. 'staged', 'unstaged', 'untracked')
  branchEntriesSnapshot?: GitBranchChangeEntry[]
  commitEntriesSnapshot?: GitBranchChangeEntry[]
  /** Why: snapshot uncommitted entries at tab-open so a later commit can't yank them out from under the combined diff (rebuild + lost scroll). */
  uncommittedEntriesSnapshot?: GitStatusEntry[]
  conflict?: OpenConflictMetadata
  skippedConflicts?: CombinedDiffSkippedConflict[]
  conflictReview?: ConflictReviewState
  isPreview?: boolean // preview tabs are replaced when another file is single-clicked
  isUntitled?: boolean // true for files created via "New Markdown" that haven't been renamed yet
  // Why: templated New Markdown files have real content at creation, unlike blank placeholders that can be discarded.
  deleteUntouchedOnClose?: boolean
  // Why: external delete/rename of an open file keeps the tab (strikethrough label); 'changed' = rewritten on disk under unsaved edits → changed-on-disk banner (#7265).
  externalMutation?: 'deleted' | 'renamed' | 'changed'
  /** Signature of the disk content this tab's edits are based on; persisted so a restore detects a changed-on-disk conflict before autosave clobbers an agent write. */
  lastKnownDiskSignature?: string
  /** Why: gates autosave for restored dirty tabs until the conflict scan compares disk vs baseline, else a slow SSH read loses the race. Not persisted. */
  pendingDiskBaselineVerification?: boolean
  /** Why: gates autosave during a live self-move echo's disk verification; separate flag from the restored scan's so the two can't clear each other's gate. Not persisted. */
  pendingLiveDiskVerification?: boolean
  /** Why: routes an Orca-owned move's destination-watcher echo into content verification. On the tab so it survives the atomic rekey; operationId supersedes a stale verification on re-move. Not persisted. */
  pendingSelfMoveEcho?: { operationId: string; targetPath: string }
  /** Why: diff bodies are cached in EditorPanel; bump this on re-select so the panel refetches instead of reusing a stale snapshot. */
  diffContentReloadNonce?: number
  /** Why: bumping refetches clean tabs — the user's manual recovery when a remote watcher misses an external write. */
  fileContentReloadNonce?: number
  /** Why: CI check-details tabs are virtual editor tabs backed by fetched PR check-run metadata, not a file on disk. */
  checkRunDetails?: OpenCheckRunDetailsState
  /** Why: web-client tab mirrored from the host snapshot; only mirrored tabs may be culled when they vanish, locally-opened tabs must survive. */
  mirroredFromRuntimeSession?: boolean
  /** Why: orthogonal to `mode` — an edit-mode tab that must never accept edits/autosave/rename (AI Vault View Log). Persisted only when true. */
  readOnly?: boolean
  /** Why: explicit live tail, only meaningful for a read-only local log. */
  liveTail?: boolean
  mode: 'edit' | 'diff' | 'conflict-review' | 'markdown-preview' | 'check-details'
}

export type ActivityBarPosition = 'top' | 'side'

export type MarkdownViewMode = 'source' | 'rich' | 'preview'

// Why: orthogonal to MarkdownViewMode; 'changes' renders diff-vs-HEAD in place of the editor without a separate tab. See reviews/changes-view-mode-plan.md.
export type EditorViewMode = 'edit' | 'changes'

/** Enough state to restore a tab via `openFile` after `closeFile` (id is always filePath). */
// Why: omit mirroredFromRuntimeSession so a user-reopened tab isn't treated as host-owned and culled by the next web session sync.
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
  // Why: route diffs by explicit worktree owner; null forces LOCAL, undefined would inherit the focused runtime → wrong host (#6957, #8484).
  return getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId) ?? null
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
  // Why: openFile may remount Monaco async; the reveal must land after remount or the old editor clears it.
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
  // Why: drafts live in the store (not a hidden mounted EditorPanel, #300) so the editor UI can unmount without losing edits.
  editorDrafts: Record<string, string>
  setEditorDraft: (fileId: string, content: string) => void
  clearEditorDraft: (fileId: string) => void
  clearEditorDrafts: (fileIds: string[]) => void

  // Markdown view mode per file (fileId -> mode)
  markdownViewMode: Record<string, MarkdownViewMode>
  setMarkdownViewMode: (fileId: string, mode: MarkdownViewMode) => void

  // Editor view mode per file (fileId -> mode). Orthogonal to markdownViewMode; absent entry means 'edit'.
  editorViewMode: Record<string, EditorViewMode>
  setEditorViewMode: (fileId: string, mode: EditorViewMode) => void

  // Per-file opt-in to render markdown-preview front matter (#4468); absent = default.
  markdownFrontmatterVisible: Record<string, boolean>
  setMarkdownFrontmatterVisible: (fileId: string, visible: boolean) => void

  // Per-file opt-in to keep the markdown TOC open; absent = hidden (default).
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
  // Why: sequences openFile/setMarkdownViewMode/reveal around an async Monaco remount. See docs/markdown-internal-link-opening-design.md.
  activateMarkdownLink: (
    rawHref: string | undefined,
    ctx: {
      sourceFilePath: string
      worktreeId: string
      worktreeRoot: string | null
      runtimeEnvironmentId?: string | null
      sourceOwner?: HttpLinkSourceOwner
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
  setExternalMutation: (fileId: string, mutation: 'deleted' | 'renamed' | 'changed' | null) => void
  setLastKnownDiskSignature: (fileId: string, signature: string) => void
  clearPendingDiskBaselineVerification: (fileId: string) => void
  setPendingDiskBaselineVerification: (fileId: string, value: boolean) => void
  setPendingLiveDiskVerification: (fileId: string, value: boolean) => void
  clearSelfMoveEcho: (fileId: string) => void
  /** Atomically retargets open editor sessions across an Orca-owned move — one commit-only update migrating every path-derived id + all id-keyed state, no close/reopen. Returns collision/stale without mutating. */
  rekeyOpenFilesForPathChange: (args: {
    rekeys: readonly OpenFilePathRekey[]
    /** When set, dirty autosave-capable destinations get move-echo provenance + a synchronous autosave gate so the watcher can content-verify the echo. */
    moveOperationId?: string
  }) => RekeyOpenFilesResult
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
  // Why: set when status hit the entry limit; SCM shows "too many changes" and pauses polling. `{ limit }` when huge, else absent.
  gitStatusHugeByWorktree: Record<string, { limit: number }>
  gitIgnoredPathsByWorktree: Record<string, string[]>
  gitConflictOperationByWorktree: Record<string, GitConflictOperation>
  trackedConflictPathsByWorktree: Record<string, Record<string, GitConflictKind>>
  trackConflictPath: (worktreeId: string, path: string, conflictKind: GitConflictKind) => void
  setGitStatus: (worktreeId: string, status: GitStatusResult) => void
  // Why: clears stale Rebasing/Merging badges on non-active worktrees without a full git status poll.
  setConflictOperation: (worktreeId: string, operation: GitConflictOperation) => void
  remoteStatusesByWorktree: Record<string, GitUpstreamStatus>
  setUpstreamStatus: (worktreeId: string, status: GitUpstreamStatus) => void
  // Why: refcount-backed busy flag; a bare boolean races across worktrees (A finishing re-enables B mid-flight). begin/end must be paired.
  isRemoteOperationActive: boolean
  remoteOperationDepth: number
  // Why: which remote op the user triggered, so the primary button mirrors its label+spinner; cleared at depth 0.
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
      resultOwner: FileSearchResultOwner | null
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
      // Why: sidebar preview reopens focus the tab without promoting it; explicit activation still promotes previews by default.
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
    // Why: split groups can share one OpenFile; a group-scoped preview replacement must not mutate it out from under another group's tab.
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

  // Why: reuse an existing editor pane rather than turning a focused agent-terminal pane into an editor tab.
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
    // Why: floating markdown tabs must not become the worktree's active editor, so update only the per-worktree maps.
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

export function buildOwnedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeOwnerKey(runtimeEnvironmentId) ?? 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}

export function buildDiffEditorFileId(
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
  // Why: one path can be open as both a diff and an editable tab; matching by path alone would collapse them onto one OpenFile.
  return [mode]
}

export function resolveEditorFileIdForOwner(
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
  // Why: preview-only markdown tabs reserve their source id too; treat it like an open editor id so same-path owners don't collapse.
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
      // Why: widened for the shared live-move rekey — a move retargets every editor-family tab (diff/conflict-review/check-details), not only plain 'editor'.
      if (!isEditorTabContentType(tab.contentType)) {
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

/** One tab's migration in an Orca-owned move; precomputed by the move coordinator. */
export type OpenFilePathRekey = {
  oldFileId: string
  newFileId: string
  oldFilePath: string
  newFilePath: string
  newRelativePath: string
  newLanguage?: string
  newMarkdownPreviewSourceFileId?: string
  /** Explicit rename of an untitled file consumes its untitled status. */
  consumeUntitled?: boolean
}

export type RekeyOpenFilesResult = { ok: true } | { ok: false; reason: 'collision' | 'stale' }

function rekeyFileIdRecord<T>(
  record: Record<string, T>,
  migrations: ReadonlyMap<string, string>
): Record<string, T> {
  let changed = false
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    const mapped = migrations.get(key)
    if (mapped !== undefined && mapped !== key) {
      next[mapped] = value
      changed = true
    } else {
      next[key] = value
    }
  }
  return changed ? next : record
}

function deleteUntouchedUntitledFile(state: AppState, file: OpenFile): void {
  const worktree = findWorktreeById(state.worktreesByRepo, file.worktreeId)
  const owningRuntimeEnvironmentId = file.runtimeEnvironmentId?.trim()
  let context: ReturnType<typeof getEditorFileOperationContext>
  try {
    context = getEditorFileOperationContext(state, file, worktree?.path ?? null)
  } catch {
    return
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

export const createEditorSlice: StateCreator<AppState, [], [], EditorSlice> = (set, get) => ({
  editorDrafts: {},
  setEditorDraft: (fileId, content) =>
    set((s) => {
      // Why: read-only tabs must never accrue a draft — it seeds dirty/autosave/hot-exit restore that could overwrite an agent transcript.
      const file = s.openFiles.find((f) => f.id === fileId)
      if (file?.readOnly === true) {
        return s
      }
      return { editorDrafts: { ...s.editorDrafts, [fileId]: content } }
    }),
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
      // Why: default is 'edit' — delete rather than store it so the record stays minimal and hydration round-trips cleanly.
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

  // Markdown preview front-matter visibility (#4468).
  markdownFrontmatterVisible: {},
  setMarkdownFrontmatterVisible: (fileId, visible) =>
    set((s) => {
      // Why: don't persist the default value; delete instead so the map carries only overrides and hydration round-trips cleanly.
      if (visible) {
        if (!(fileId in s.markdownFrontmatterVisible)) {
          return s
        }
        const next = { ...s.markdownFrontmatterVisible }
        delete next[fileId]
        return { markdownFrontmatterVisible: next }
      }
      return { markdownFrontmatterVisible: { ...s.markdownFrontmatterVisible, [fileId]: false } }
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
              resultOwner: null,
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
      let operationProvenance = file.operationProvenance
      if (!operationProvenance && file.mode === 'edit' && file.readOnly !== true) {
        try {
          operationProvenance = captureEditorFileOperationProvenance(
            s,
            worktreeId,
            options?.suppressActiveRuntimeFallback ? null : file.runtimeEnvironmentId,
            options?.suppressActiveRuntimeFallback === true ||
              file.runtimeEnvironmentId !== undefined
          )
        } catch (error) {
          toast.error(extractIpcErrorMessage(error, 'Failed to resolve file owner.'))
          // Why: mirrored tabs can arrive before their graph row; allow convergence while mutation paths still fail closed without provenance.
        }
      }
      const runtimeEnvironmentId = operationProvenance
        ? operationProvenance.generation.route.runtimeEnvironmentId
        : file.runtimeEnvironmentId === null
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
      // Why: resolve the target group up-front so preview replacement is scoped to it (group B open must not evict group A's preview).
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
        // Why: `readOnly` is intentionally NOT in this override map — it's sticky, so `...f` preserves the tab's own read-only state.
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

      // Why: scope preview replacement to worktreeId + targetGroupId so link clicks in group B don't evict group A's previews.
      let newFiles = s.openFiles
      if (isPreview) {
        const replaceablePreviewId = getReplaceablePreviewFileId(s, worktreeId, targetGroupId)
        const existingPreviewIdx = s.openFiles.findIndex((f) => f.id === replaceablePreviewId)
        if (existingPreviewIdx !== -1) {
          const replacedPreview = s.openFiles[existingPreviewIdx]
          // Why: reuse the shared eviction helper so per-file cursor/draft/visibility cleanup stays in one place.
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
              ? {
                  ...file,
                  id,
                  isDirty: false,
                  isPreview: true,
                  runtimeEnvironmentId,
                  operationProvenance
                }
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
          // Why: push the evicted preview onto the recently-closed stack so Cmd/Ctrl+Shift+T can reopen it; gated to keep file-explorer clicks silent.
          let nextRecentlyClosed = s.recentlyClosedEditorTabsByWorktree
          let nextRecentlyClosedKinds = s.recentlyClosedTabKindsByWorktree
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
            nextRecentlyClosedKinds = pushRecentlyClosedTabKind(
              s.recentlyClosedTabKindsByWorktree,
              worktreeId,
              'editor'
            )
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
            recentlyClosedTabKindsByWorktree: nextRecentlyClosedKinds,
            ...previewTabBarUpdate,
            ...activeResult
          }
        }
      }

      // Why: append to the persisted tab bar order, else TabBar's reconcileOrder falls back to type-grouped ordering (terminals first).
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
            runtimeEnvironmentId,
            operationProvenance
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
      const operationProvenance = captureEditorFileOperationProvenance(
        state,
        worktreeId,
        undefined,
        false
      )
      const operationContext = getEditorFileOperationContext(
        state,
        { worktreeId, operationProvenance },
        worktree.path
      )
      const fileInfo = await createUntitledMarkdownFileWithTemplateSelection(
        worktree.path,
        worktreeId,
        operationContext.connectionId,
        operationContext.settings,
        operationProvenance,
        operationContext.expectedSshConnectionGeneration,
        operationContext.expectedSshTargetId,
        operationContext.expectedExecutionHostId,
        () => assertEditorFileOperationCurrent(get(), worktreeId, operationProvenance)
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

  // Why: closing a tab does NOT clear Resolved-locally state — trackedConflictPaths is tied to sidebar presence, not tab lifecycle.
  closeFile: (fileId) => {
    // Why: capture untitled+dirty state before set() mutates the store, so cleanup of throwaway untitled files can decide after removal.
    const preClose = get().openFiles.find((f) => f.id === fileId)
    // Why: also check editorDrafts — isDirty is set by a debounced callback, so a draft can exist before isDirty flushes; a draft means the user typed something.
    const hasDraft = !!get().editorDrafts[fileId]
    const shouldDeleteFromDisk = shouldDeleteUntouchedUntitledFile(preClose, hasDraft)

    // Why: mirrored tabs are host-owned, so the host must close its copy or its next snapshot re-mirrors the file and the tab reopens.
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
      // Why: editorCursorLine is keyed by fileId and grows unbounded across a long session without cleanup on close.
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

      // Why: editors share a mixed tab strip with browser tabs; closing the last editor should reveal a browser tab before falling back to a terminal.
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

      // Why: prune the closed id from tabBarOrderByWorktree so stale ids don't shift positions on the next reconcile.
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
      let nextRecentlyClosedKinds = s.recentlyClosedTabKindsByWorktree
      const wtRecent = closedFile?.worktreeId
      // Why: exclude untitled unedited files (deleted from disk after close, so Cmd+Shift+T can't reopen a gone path) and ephemeral preview tabs from the reopen stack.
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
        nextRecentlyClosedKinds = pushRecentlyClosedTabKind(
          s.recentlyClosedTabKindsByWorktree,
          wtRecent,
          'editor'
        )
      }

      return {
        openFiles: newFiles,
        editorDrafts: newEditorDrafts,
        editorCursorLine: newEditorCursorLine,
        activeFileId: newActiveId,
        // Why: if the last editor closes with no browser/terminal surface left, return to the landing state like the terminal/browser close handlers do.
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
        recentlyClosedEditorTabsByWorktree: nextRecentlyClosed,
        recentlyClosedTabKindsByWorktree: nextRecentlyClosedKinds
      }
    })

    // Why: untitled unedited files exist on disk only because createUntitledMarkdownFile() eagerly writes a bindable path; delete the clutter (fire-and-forget).
    if (shouldDeleteFromDisk && preClose && typeof window !== 'undefined') {
      deleteUntouchedUntitledFile(get(), preClose)
    }

    // Why: route editor/diff closes through the unified close path (MRU + visual-neighbor fallback) so they match terminal/browser tab-close behavior.
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

    // Why: like closeFile — untitled unedited files are empty placeholders that shouldn't survive close-all.
    const untitledToDelete = state.openFiles.filter(
      (f) =>
        shouldDeleteUntouchedUntitledFile(f, !!state.editorDrafts[f.id]) &&
        (!activeWorktreeId || f.worktreeId === activeWorktreeId)
    )
    const closingFiles = state.openFiles.filter(
      (file) => !activeWorktreeId || file.worktreeId === activeWorktreeId
    )
    // Why: close-all bypasses closeFile, so notify mirrored host-owned editors here or the next host snapshot reopens them.
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

      // Why: mirrored tabs use host tab ids in tab order while local entries use file ids; remove both shapes.
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
      let capturedCloseCount = 0
      for (const f of [...closingFiles].toReversed()) {
        // Why: skip untitled non-dirty files (deleted from disk after close) and ephemeral preview tabs so the reopen stack has no vanished/junk paths.
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
        capturedCloseCount += 1
      }

      return {
        openFiles: newFiles,
        editorDrafts: newEditorDrafts,
        editorCursorLine: newEditorCursorLine,
        activeFileId: null,
        // Why: closing every editor can leave no renderable surface; clear the active worktree so the renderer shows the landing page, not a blank workspace.
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
        // Why: clear the one-shot search reveal; keeping it after closing all editors would make a later reopen jump to an old match.
        pendingEditorReveal: null,
        recentlyClosedEditorTabsByWorktree: {
          ...s.recentlyClosedEditorTabsByWorktree,
          [activeWorktreeId]: nextRecentClosed
        },
        recentlyClosedTabKindsByWorktree: pushRecentlyClosedTabKind(
          s.recentlyClosedTabKindsByWorktree,
          activeWorktreeId,
          'editor',
          capturedCloseCount
        )
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
      // Why: this fires on every keystroke; rebuilding openFiles unconditionally thrashes subscribers and caused typing lag, so bail when nothing changes.
      const file = s.openFiles.find((f) => f.id === fileId)
      if (!file) {
        return s
      }
      // Why: read-only tabs can never become dirty; hard no-op any stray change/save callback that reached here.
      if (file.readOnly === true) {
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

  setLastKnownDiskSignature: (fileId, signature) =>
    set((s) => {
      const file = s.openFiles.find((f) => f.id === fileId)
      if (!file || file.lastKnownDiskSignature === signature) {
        return s
      }
      return {
        openFiles: s.openFiles.map((f) =>
          f.id === fileId ? { ...f, lastKnownDiskSignature: signature } : f
        )
      }
    }),

  clearPendingDiskBaselineVerification: (fileId) =>
    set((s) => {
      const file = s.openFiles.find((f) => f.id === fileId)
      if (!file?.pendingDiskBaselineVerification) {
        return s
      }
      return {
        openFiles: s.openFiles.map((f) =>
          f.id === fileId ? { ...f, pendingDiskBaselineVerification: undefined } : f
        )
      }
    }),

  setPendingDiskBaselineVerification: (fileId, value) =>
    set((s) => {
      const file = s.openFiles.find((f) => f.id === fileId)
      const next = value || undefined
      if (!file || file.pendingDiskBaselineVerification === next) {
        return s
      }
      return {
        openFiles: s.openFiles.map((f) =>
          f.id === fileId ? { ...f, pendingDiskBaselineVerification: next } : f
        )
      }
    }),

  setPendingLiveDiskVerification: (fileId, value) =>
    set((s) => {
      const file = s.openFiles.find((f) => f.id === fileId)
      const next = value || undefined
      if (!file || file.pendingLiveDiskVerification === next) {
        return s
      }
      return {
        openFiles: s.openFiles.map((f) =>
          f.id === fileId ? { ...f, pendingLiveDiskVerification: next } : f
        )
      }
    }),

  clearSelfMoveEcho: (fileId) =>
    set((s) => {
      const file = s.openFiles.find((f) => f.id === fileId)
      if (!file?.pendingSelfMoveEcho) {
        return s
      }
      return {
        openFiles: s.openFiles.map((f) =>
          f.id === fileId ? { ...f, pendingSelfMoveEcho: undefined } : f
        )
      }
    }),

  rekeyOpenFilesForPathChange: ({ rekeys, moveOperationId }) => {
    if (rekeys.length === 0) {
      return { ok: true }
    }
    let result: RekeyOpenFilesResult = { ok: true }
    set((s) => {
      const migrations = new Map<string, string>()
      const rekeyByOldId = new Map<string, OpenFilePathRekey>()
      for (const rekey of rekeys) {
        migrations.set(rekey.oldFileId, rekey.newFileId)
        rekeyByOldId.set(rekey.oldFileId, rekey)
      }
      const openById = new Map(s.openFiles.map((f) => [f.id, f]))

      // Preflight (atomic with apply): every source still open, target ids unique,
      // and no target id belongs to an UNAFFECTED live session (never merge two).
      const seenNewIds = new Set<string>()
      for (const rekey of rekeys) {
        if (!openById.has(rekey.oldFileId)) {
          result = { ok: false, reason: 'stale' }
          return s
        }
        if (seenNewIds.has(rekey.newFileId)) {
          result = { ok: false, reason: 'collision' }
          return s
        }
        seenNewIds.add(rekey.newFileId)
        const occupier = openById.get(rekey.newFileId)
        if (occupier && !migrations.has(occupier.id)) {
          result = { ok: false, reason: 'collision' }
          return s
        }
      }

      const nextOpenFiles = s.openFiles.map((f) => {
        const rekey = rekeyByOldId.get(f.id)
        if (!rekey) {
          return f
        }
        // Spread the whole OpenFile so fields this action doesn't know about survive; change only the path-derived ones.
        // Gate atomically here so autosave is suspended before any echo can be verified (only a dirty autosave-capable tab can be clobbered).
        const gatesEcho =
          moveOperationId !== undefined &&
          f.isDirty &&
          // A 'changed' tab is already autosave-suspended via externalMutation; gating it would strand the gate (verification skips a 'changed' tab), so leave the banner as terminal.
          f.externalMutation !== 'changed' &&
          (f.mode === 'edit' || (f.mode === 'diff' && f.diffSource === 'unstaged'))
        return {
          ...f,
          id: rekey.newFileId,
          filePath: rekey.newFilePath,
          relativePath: rekey.newRelativePath,
          // A moved tab's id no longer matches the host snapshot, so leaving it host-owned would cull it (losing the draft); the coordinator close-notifies the host's old-path tab. (Re-homing the host tab in place is a follow-up.)
          mirroredFromRuntimeSession: undefined,
          ...(rekey.newLanguage !== undefined ? { language: rekey.newLanguage } : {}),
          ...(rekey.newMarkdownPreviewSourceFileId !== undefined
            ? { markdownPreviewSourceFileId: rekey.newMarkdownPreviewSourceFileId }
            : {}),
          ...(rekey.consumeUntitled
            ? { isUntitled: undefined, deleteUntouchedOnClose: undefined }
            : {}),
          ...(gatesEcho
            ? {
                pendingLiveDiskVerification: true,
                pendingSelfMoveEcho: {
                  operationId: moveOperationId,
                  targetPath: rekey.newFilePath
                }
              }
            : {})
        }
      })

      const activeFileIdByWorktree: Record<string, string | null> = {}
      for (const [wtId, activeId] of Object.entries(s.activeFileIdByWorktree)) {
        activeFileIdByWorktree[wtId] = activeId ? (migrations.get(activeId) ?? activeId) : activeId
      }

      // Partition by each moved file's OWN worktree: the same path can be open in more than one worktree (e.g. a floating workspace), and tab-bar / group state is per-worktree.
      const migrationsByWorktree: Record<string, Map<string, string>> = {}
      for (const rekey of rekeys) {
        const wtId = openById.get(rekey.oldFileId)!.worktreeId
        ;(migrationsByWorktree[wtId] ??= new Map()).set(rekey.oldFileId, rekey.newFileId)
      }

      const tabBarOrderByWorktree = { ...s.tabBarOrderByWorktree }
      for (const [wtId, wtMigrations] of Object.entries(migrationsByWorktree)) {
        const prevBarOrder = tabBarOrderByWorktree[wtId]
        if (prevBarOrder) {
          tabBarOrderByWorktree[wtId] = prevBarOrder.map((id) => wtMigrations.get(id) ?? id)
        }
      }

      const reveal = s.pendingEditorReveal
      const rekeyForReveal = reveal
        ? rekeys.find((r) => r.oldFilePath === reveal.filePath)
        : undefined

      return {
        openFiles: nextOpenFiles,
        editorDrafts: rekeyFileIdRecord(s.editorDrafts, migrations),
        editorCursorLine: rekeyFileIdRecord(s.editorCursorLine, migrations),
        markdownViewMode: rekeyFileIdRecord(s.markdownViewMode, migrations),
        editorViewMode: rekeyFileIdRecord(s.editorViewMode, migrations),
        markdownFrontmatterVisible: rekeyFileIdRecord(s.markdownFrontmatterVisible, migrations),
        markdownTableOfContentsVisible: rekeyFileIdRecord(
          s.markdownTableOfContentsVisible,
          migrations
        ),
        activeFileId: s.activeFileId ? (migrations.get(s.activeFileId) ?? s.activeFileId) : null,
        activeFileIdByWorktree,
        tabBarOrderByWorktree,
        ...migrateHydratedEditorTabsAndGroups(s, migrationsByWorktree),
        ...(reveal && rekeyForReveal
          ? {
              pendingEditorReveal: {
                ...reveal,
                filePath: rekeyForReveal.newFilePath,
                // matchesPendingEditorReveal prefers fileId, so migrate it too or
                // the reveal would never match the rekeyed tab.
                ...(reveal.fileId ? { fileId: migrations.get(reveal.fileId) ?? reveal.fileId } : {})
              }
            }
          : {})
      }
    })
    return result
  },

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
      // Why: snapshot entries at open time so a later commit can't yank them and force a rebuild that loses loaded content + scroll position.
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

    // Why: the conflict file needs a normal editor backing tab for save/close, but selecting from Conflict Review must keep the review tab visible; restore focus after.
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

  // Why: renders from a stored snapshot (entries + timestamp), not live status, so the list stays stable across polls while reviewing.
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

  // Why: the checks sidebar only fits inline summaries; full logs and annotations belong in the center editor pane.
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

  // Why: sidebar detail fetches can finish after the full-details tab is open; update the snapshot without stealing focus.
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
  // Why: session-local conflict tracking (Resolved-locally) lives only in the renderer; main returns raw git status, so the renderer owns conflictStatusSource.
  setGitStatus: (worktreeId, status) =>
    set((s) => {
      const hadStatusEntry = Object.prototype.hasOwnProperty.call(s.gitStatusByWorktree, worktreeId)
      const prevEntries = s.gitStatusByWorktree[worktreeId] ?? []
      const prevOperation = s.gitConflictOperationByWorktree[worktreeId] ?? 'unknown'
      const currentTracked = { ...s.trackedConflictPathsByWorktree[worktreeId] }
      // Why: main process doesn't set conflictStatusSource; stamp 'git' here for live u-records ('session' is stamped below for Resolved-locally).
      const normalizedEntries = status.entries.map((entry) =>
        entry.conflictStatus === 'unresolved'
          ? { ...entry, conflictStatusSource: 'git' as const }
          : entry
      )
      const unresolvedEntries = normalizedEntries.filter(
        (entry) => entry.conflictStatus === 'unresolved' && entry.conflictKind
      )
      const unresolvedByPath = new Map(unresolvedEntries.map((entry) => [entry.path, entry]))
      const statusIsComplete = status.didHitLimit !== true
      // Why: a capped snapshot cannot prove that an omitted conflict operation ended.
      const nextOperation =
        !statusIsComplete && status.conflictOperation === 'unknown'
          ? prevOperation
          : status.conflictOperation

      // Why: operation → 'unknown' with zero unresolved means an abort (git merge --abort), not resolution; clear tracked paths instead of marking each "Resolved locally".
      if (
        statusIsComplete &&
        nextOperation === 'unknown' &&
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

      if (statusIsComplete) {
        const visiblePaths = new Set(nextEntries.map((entry) => entry.path))
        for (const path of Object.keys(currentTracked)) {
          if (!visiblePaths.has(path) && !unresolvedByPath.has(path)) {
            delete currentTracked[path]
          }
        }
      }

      const nextOpenFiles = reconcileOpenFilesForStatus(
        s.openFiles,
        worktreeId,
        nextEntries,
        statusIsComplete
      )
      const statusUnchanged = hadStatusEntry && areGitStatusEntriesEqual(prevEntries, nextEntries)
      const trackedUnchanged = areTrackedConflictMapsEqual(
        s.trackedConflictPathsByWorktree[worktreeId] ?? {},
        currentTracked
      )
      const openFilesUnchanged = nextOpenFiles === s.openFiles
      const operationUnchanged = prevOperation === nextOperation

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
      // Why: a compare request can finish after git status observed a new HEAD; reject the stale snapshot before it renders a false clean state.
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
          : { ...s.gitConflictOperationByWorktree, [worktreeId]: nextOperation },
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
      // Why: when the operation clears on a non-active worktree, also clear tracked conflict paths — same as setGitStatus does for the active one.
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
      // Why: last-write-wins on the kind; the UI blocks a second user-initiated op, so the most recent kind matches what the user is watching.
      inFlightRemoteOpKind: kind ?? s.inFlightRemoteOpKind
    })),
  endRemoteOperation: () =>
    set((s) => {
      const next = Math.max(0, s.remoteOperationDepth - 1)
      return {
        remoteOperationDepth: next,
        isRemoteOperationActive: next > 0,
        // Why: keep the in-flight kind (its label/spinner) until depth reaches 0 and no remote op remains.
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
      // Why: keep prior status on error — a synthetic {hasUpstream:false} would flash 'Publish Branch' on a tracked branch and a click could re-publish, clobbering the upstream.
      if (pushTarget) {
        // Why: don't let an old automatic-poll cache entry suppress the next retry after a transient refresh failure.
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
    // Why: fire-and-forget the upstream refresh (don't await) so compound flows aren't delayed, but the "Push"→"Commit" label still rotates faster than the 3s poll.
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
        // Why: the rejected push proved the branch moved; fetch first so legacy base-tracking worktrees discover origin/<branch>, then refresh ahead/behind.
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
    // Why: like pushBranch — fire-and-forget the post-op upstream refresh so the primary button label rotates immediately.
    get().beginRemoteOperation('sync')
    // Why: the inner push stage toasts as Sync and marks the error so the outer catch skips toasting, avoiding a double-toast.
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
          toast.error(
            resolveRemoteOperationErrorMessage(error, {
              isSync: true,
              isSyncPushStage: true
            })
          )
          pushStageToastShown = true
          throw markSyncPushStageError(error)
        }
      } else {
        await pullRuntimeGit(context, pushTarget)
        // Why: push only if the pull left local commits ahead of the remote; skip the no-op push after a pure fast-forward.
        const upstreamStatus = await getRuntimeGitUpstreamStatus(context, pushTarget)
        if (upstreamStatus.ahead > 0) {
          try {
            await pushRuntimeGit(context, { pushTarget })
            pushed = true
          } catch (error) {
            // Why: frame as Sync, not the inner push — the user clicked Sync and didn't directly invoke this push.
            toast.error(
              resolveRemoteOperationErrorMessage(error, {
                isSync: true,
                isSyncPushStage: true
              })
            )
            pushStageToastShown = true
            throw markSyncPushStageError(error)
          }
        }
      }
    } catch (error) {
      if (!pushStageToastShown) {
        // Why: frame fetch/pull/upstream failures as "Sync failed..." since the user invoked Sync, not the inner step.
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
    // Why: like pushBranch — fire-and-forget the upstream refresh after the busy flag clears so new ahead/behind counts surface.
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
      // Why: never let a compare result computed before a status change overwrite a newer status snapshot.
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
  // Why: when the compare base resolves to "no base", drop any stale summary so the committed-changes section and "vs" row disappear instead of lingering.
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
            resultOwner: null,
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
            resultOwner: null,
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
            resultOwner: null,
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
    let inferredRuntimeEnvironmentId: string | null | undefined
    if (!ctx.sourceOwner && ctx.runtimeEnvironmentId === undefined) {
      const inferredRuntimeOwners = new Set(
        initialState.openFiles
          .filter(
            (file) => file.filePath === ctx.sourceFilePath && file.worktreeId === ctx.worktreeId
          )
          .map((file) => file.runtimeEnvironmentId?.trim() || null)
      )
      if (inferredRuntimeOwners.size > 1) {
        return
      }
      inferredRuntimeEnvironmentId =
        inferredRuntimeOwners.size === 1 ? [...inferredRuntimeOwners][0] : undefined
    }
    const sourceRuntimeEnvironmentId =
      ctx.sourceOwner?.kind === 'runtime'
        ? ctx.sourceOwner.runtimeEnvironmentId
        : ctx.sourceOwner
          ? null
          : ctx.runtimeEnvironmentId !== undefined
            ? ctx.runtimeEnvironmentId
            : inferredRuntimeEnvironmentId
    const runtimeOwnerId = sourceRuntimeEnvironmentId?.trim() || null
    const sourceSettings = settingsForRuntimeOwner(initialState.settings, runtimeOwnerId)
    const resolvedConnectionId =
      ctx.sourceOwner || runtimeOwnerId
        ? undefined
        : getConnectionIdForFileFromState(initialState, ctx.worktreeId, ctx.sourceFilePath)
    const sourceOwner: HttpLinkSourceOwner =
      ctx.sourceOwner ??
      (runtimeOwnerId
        ? { kind: 'runtime', runtimeEnvironmentId: runtimeOwnerId }
        : resolvedConnectionId === undefined
          ? { kind: 'unknown' }
          : resolvedConnectionId === null
            ? { kind: 'local' }
            : { kind: 'ssh', connectionId: resolvedConnectionId })
    if (sourceOwner.kind === 'unknown') {
      return
    }
    const sourceConnectionId = sourceOwner.kind === 'ssh' ? sourceOwner.connectionId : undefined
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
      openHttpLink(target.url, { worktreeId: ctx.worktreeId, sourceOwner })
      return
    }
    if (target.kind === 'file') {
      const { line, column } = target
      if (target.relativePath === undefined) {
        if (isLocalPathOpenBlocked(sourceSettings, { connectionId: sourceConnectionId })) {
          // Why: a file:// link outside the worktree is client-local; remote runtime/SSH editors must not treat server paths as client paths.
          showLocalPathOpenBlockedToast()
          return
        }
        // Why: markdown file:// links need the same user-gesture authorization terminal links get, so external paths (e.g. /tmp screenshots) can open in Orca.
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
      // Why: MonacoEditor drops the reveal if the file stays in rich mode; switch to source using the resolved owner-qualified id.
      get().setMarkdownViewMode(fileId, 'source')
      scheduleEditorLineReveal(get, absolutePath, line, column, fileId)
    }
  },

  // Why: only edit-mode files are restored — diffs/conflict views depend on transient git state that may be stale between sessions.
  hydrateEditorSession: (session, options) => {
    set((s) => {
      const openFilesByWorktree = session.openFilesByWorktree ?? {}
      const persistedActiveFileIdByWorktree = session.activeFileIdByWorktree ?? {}
      const persistedActiveTabTypeByWorktree = session.activeTabTypeByWorktree ?? {}
      const persistedMarkdownFrontmatterVisible = session.markdownFrontmatterVisible ?? {}

      const validWorktreeIds = buildValidWorktreeIdsForSessionHydration(
        s,
        Object.keys(openFilesByWorktree)
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
          // Why: floating/runtime-owned files need IDs that survive peers disappearing between restarts; collision-based IDs drift when the path is no longer open elsewhere.
          const ownedId = buildOwnedEditorFileId(pf.filePath, worktreeId, pf.runtimeEnvironmentId)
          const id =
            shouldHydrateWithOwnedEditorFileId(worktreeId, pf.runtimeEnvironmentId) ||
            usedOpenFileIds.has(pf.filePath)
              ? ownedId
              : pf.filePath
          usedOpenFileIds.add(id)
          // Why: map from the collision-derived legacy id; keying by filePath would collapse same-path local/runtime tabs onto the last owner to hydrate.
          addEditorFileIdMigration(editorFileIdMigrationsByWorktree, worktreeId, legacyId, id)
          legacyHydratedOpenFiles.push({
            id: legacyId,
            filePath: pf.filePath,
            worktreeId,
            runtimeEnvironmentId: pf.runtimeEnvironmentId
          })
          // Why: read-only tabs (AI Vault View Log) must restore clean — ignore any persisted dirty draft/baseline so they can't come back writable.
          const isReadOnly = pf.readOnly === true
          if (!isReadOnly && pf.dirtyDraftContent !== undefined) {
            editorDrafts[id] = pf.dirtyDraftContent
          }
          openFiles.push({
            id,
            filePath: pf.filePath,
            relativePath: pf.relativePath,
            worktreeId,
            // Why: re-detect language on hydrate — older sessions stored ids from before extensions like .ipynb were supported.
            language: detectLanguage(pf.relativePath || pf.filePath),
            isDirty: !isReadOnly && pf.dirtyDraftContent !== undefined,
            isPreview: pf.isPreview,
            runtimeEnvironmentId: pf.runtimeEnvironmentId,
            ...(isReadOnly ? { readOnly: true } : {}),
            ...(isReadOnly && pf.liveTail === true ? { liveTail: true } : {}),
            lastKnownDiskSignature: isReadOnly ? undefined : pf.lastKnownDiskSignature,
            // Why: suspend autosave until the conflict scan verifies disk vs baseline, else a slow remote read clobbers an offline write.
            pendingDiskBaselineVerification:
              !isReadOnly &&
              pf.dirtyDraftContent !== undefined &&
              pf.lastKnownDiskSignature !== undefined
                ? true
                : undefined,
            mode: 'edit'
          })
        }
      }

      // Why: use the store's activeWorktreeId — hydrateWorkspaceSession may have nulled an invalid ID, and we must respect that.
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
      // Why: the persisted active file may be gone (worktree validation or stale path), so verify it exists in the restored set.
      const activeFileExists = persistedActiveFileId
        ? openFiles.some((f) => f.id === persistedActiveFileId && f.worktreeId === activeWorktreeId)
        : false
      // Why: the previous active surface may have been a transient diff/conflict tab (not restored), so promote the first restored edit file.
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
          // Why: an "editor" marker is valid only if the worktree restored a concrete active file; otherwise it's a stale marker.
          return Boolean(filteredActiveFileIdByWorktree[wId])
        })
      )

      // Why: transient diff/conflict surfaces aren't restored, so clear a stale "editor" marker and fall back to terminal.
      const nextActiveTabType =
        nextActiveFileId || activeTabType !== 'editor' ? activeTabType : 'terminal'
      const openFileIds = new Set(openFiles.map((file) => file.id))
      // Why: visible is the default, so restore only per-file hide overrides (`false`); legacy `true` entries collapse to the default.
      const hiddenFrontmatterEntries = new Map<string, boolean>()
      for (const [persistedFileId, visible] of Object.entries(
        persistedMarkdownFrontmatterVisible
      )) {
        if (visible) {
          continue
        }
        if (openFileIds.has(persistedFileId)) {
          hiddenFrontmatterEntries.set(persistedFileId, false)
        }
        for (const migrations of Object.values(editorFileIdMigrationsByWorktree)) {
          const migratedFileId = migrations.get(persistedFileId)
          if (migratedFileId && openFileIds.has(migratedFileId)) {
            hiddenFrontmatterEntries.set(migratedFileId, false)
          }
        }
      }
      const markdownFrontmatterVisible = Object.fromEntries(hiddenFrontmatterEntries)

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

// Why: conflict state can change (unresolved↔resolved_locally) without the base status changing, so also compare conflict fields.
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
  nextEntries: GitStatusEntry[],
  statusIsComplete: boolean
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

    // Why: a capped snapshot cannot prove that an omitted conflict was resolved.
    if (!entry && !statusIsComplete) {
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
