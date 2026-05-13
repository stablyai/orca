/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { joinPath } from '@/lib/path'
import { toast } from 'sonner'
import { resolveMarkdownLinkTarget } from '@/components/editor/markdown-internal-links'
import { openHttpLink } from '@/lib/http-link-routing'
import { detectLanguage } from '@/lib/language-detect'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitConflictKind,
  GitConflictOperation,
  GitConflictResolutionStatus,
  GitConflictStatusSource,
  GitStatusEntry,
  GitStatusResult,
  GitUpstreamStatus,
  SearchResult,
  WorkspaceSessionState,
  WorkspaceVisibleTabType
} from '../../../../shared/types'
import { stripCredentialsFromMessage } from '../../../../shared/git-remote-error'
import type { RemoteOpKind } from '@/components/right-sidebar/source-control-primary-action'

export type DiffSource =
  | 'unstaged'
  | 'staged'
  | 'branch'
  | 'combined-uncommitted'
  | 'combined-branch'

export type BranchCompareSnapshot = Pick<
  GitBranchCompareSummary,
  'baseRef' | 'baseOid' | 'compareRef' | 'headOid' | 'mergeBase'
> & {
  compareVersion: string
}

type CombinedDiffAlternate = {
  source: 'combined-uncommitted' | 'combined-branch'
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
  branchOldPath?: string
  combinedAlternate?: CombinedDiffAlternate
  combinedAreaFilter?: string // filter combined diff to a specific area (e.g. 'staged', 'unstaged', 'untracked')
  branchEntriesSnapshot?: GitBranchChangeEntry[]
  /** Why: snapshot uncommitted entries at tab-open time so a subsequent commit
   *  does not yank entries out from under the combined diff, which would rebuild
   *  all sections and lose loaded content + scroll position. */
  uncommittedEntriesSnapshot?: GitStatusEntry[]
  conflict?: OpenConflictMetadata
  skippedConflicts?: CombinedDiffSkippedConflict[]
  conflictReview?: ConflictReviewState
  isPreview?: boolean // preview tabs are replaced when another file is single-clicked
  isUntitled?: boolean // true for files created via "New Markdown" that haven't been renamed yet
  // Why: when an external process (e.g. `git mv`, `rm`) removes the file on
  // disk while it's open, we keep the tab around so the user can still see
  // (and potentially save) their in-memory content. The tab surfaces this as
  // a strikethrough label plus a "deleted"/"renamed" suffix. Cleared if the
  // file reappears on disk at its original path.
  externalMutation?: 'deleted' | 'renamed'
  mode: 'edit' | 'diff' | 'conflict-review' | 'markdown-preview'
}

export type RightSidebarTab = 'explorer' | 'search' | 'source-control' | 'checks' | 'ports'
export type ActivityBarPosition = 'top' | 'side'

export type MarkdownViewMode = 'source' | 'rich' | 'preview'

// Why: orthogonal to MarkdownViewMode. 'changes' flips the editor tab to a
// diff-against-HEAD rendering (working tree incl. unsaved draft vs HEAD) in
// place of the normal editor, without creating a separate tab. The per-tab
// Tab.contentType stays 'editor' for the whole lifetime; this slice drives
// what EditorPanel *renders* for that tab. See reviews/changes-view-mode-plan.md.
export type EditorViewMode = 'edit' | 'changes'

/** Enough state to restore a tab via `openFile` after `closeFile` (id is always filePath). */
export type ClosedEditorTabSnapshot = Omit<OpenFile, 'id' | 'isDirty'>

const MAX_RECENT_CLOSED_EDITOR_TABS = 10

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

  // Right sidebar
  rightSidebarOpen: boolean
  rightSidebarWidth: number
  rightSidebarTab: RightSidebarTab
  activityBarPosition: ActivityBarPosition
  toggleRightSidebar: () => void
  setRightSidebarOpen: (open: boolean) => void
  setRightSidebarWidth: (width: number) => void
  setRightSidebarTab: (tab: RightSidebarTab) => void
  setActivityBarPosition: (position: ActivityBarPosition) => void

  // File explorer state
  expandedDirs: Record<string, Set<string>> // worktreeId -> set of expanded dir paths
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
    options?: { preview?: boolean; targetGroupId?: string; recordReplacedPreview?: boolean }
  ) => void
  // Why: dispatcher for markdown link activation. Lives on the slice because it
  // sequences openFile, setMarkdownViewMode, and setPendingEditorReveal around
  // an async Monaco remount — all reading/writing state in this slice. See
  // docs/markdown-internal-link-opening-design.md.
  activateMarkdownLink: (
    rawHref: string | undefined,
    ctx: { sourceFilePath: string; worktreeId: string; worktreeRoot: string | null }
  ) => Promise<void>
  openMarkdownPreview: (
    file: Pick<OpenFile, 'filePath' | 'relativePath' | 'worktreeId' | 'language'>,
    options?: { anchor?: string | null; targetGroupId?: string }
  ) => void
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
    staged: boolean
  ) => void
  openBranchDiff: (
    worktreeId: string,
    worktreePath: string,
    entry: GitBranchChangeEntry,
    compare: GitBranchCompareSummary,
    language: string
  ) => void
  openAllDiffs: (
    worktreeId: string,
    worktreePath: string,
    alternate?: CombinedDiffAlternate,
    areaFilter?: string
  ) => void
  openConflictFile: (
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
  openBranchAllDiffs: (
    worktreeId: string,
    worktreePath: string,
    compare: GitBranchCompareSummary,
    alternate?: CombinedDiffAlternate
  ) => void

  // Cursor line tracking per file
  editorCursorLine: Record<string, number>
  setEditorCursorLine: (fileId: string, line: number) => void

  // Git status cache
  gitStatusByWorktree: Record<string, GitStatusEntry[]>
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
    connectionId?: string
  ) => Promise<void>
  pushBranch: (
    worktreeId: string,
    worktreePath: string,
    publish?: boolean,
    connectionId?: string
  ) => Promise<void>
  pullBranch: (worktreeId: string, worktreePath: string, connectionId?: string) => Promise<void>
  syncBranch: (worktreeId: string, worktreePath: string, connectionId?: string) => Promise<void>
  fetchBranch: (worktreeId: string, worktreePath: string, connectionId?: string) => Promise<void>
  gitBranchChangesByWorktree: Record<string, GitBranchChangeEntry[]>
  gitBranchCompareSummaryByWorktree: Record<string, GitBranchCompareSummary | null>
  gitBranchCompareRequestKeyByWorktree: Record<string, string>
  beginGitBranchCompareRequest: (worktreeId: string, requestKey: string, baseRef: string) => void
  setGitBranchCompareResult: (
    worktreeId: string,
    requestKey: string,
    result: { summary: GitBranchCompareSummary; entries: GitBranchChangeEntry[] }
  ) => void

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
    }
  >
  updateFileSearchState: (
    worktreeId: string,
    updates: Partial<EditorSlice['fileSearchStateByWorktree'][string]>
  ) => void
  toggleFileSearchCollapsedFile: (worktreeId: string, filePath: string) => void
  clearFileSearch: (worktreeId: string) => void

  // Editor navigation (for search result → go-to-line)
  pendingEditorReveal: {
    filePath: string
    line: number
    column: number
    matchLength: number
  } | null
  setPendingEditorReveal: (
    reveal: { filePath: string; line: number; column: number; matchLength: number } | null
  ) => void

  // Session hydration — restore editor files from persisted workspace session
  hydrateEditorSession: (session: WorkspaceSessionState) => void
}

function openWorkspaceEditorItem(
  state: AppState,
  fileId: string,
  worktreeId: string,
  label: string,
  contentType: 'editor' | 'diff' | 'conflict-review',
  isPreview?: boolean,
  targetGroupId?: string
): string {
  const resolvedGroupId =
    targetGroupId ??
    state.activeGroupIdByWorktree?.[worktreeId] ??
    state.groupsByWorktree?.[worktreeId]?.[0]?.id
  if (!resolvedGroupId) {
    return fileId
  }
  const existing = state.findTabForEntityInGroup?.(worktreeId, resolvedGroupId, fileId, contentType)
  if (existing) {
    state.activateTab?.(existing.id)
    return existing.id
  }
  const created = state.createUnifiedTab?.(worktreeId, contentType, {
    entityId: fileId,
    label,
    isPreview,
    targetGroupId: resolvedGroupId
  })
  return created?.id ?? fileId
}

const REMOTE_OPERATION_FAILED_MESSAGE = 'Remote operation failed'
const REMOTE_OPERATION_DETAIL_MAX_LENGTH = 200

// Why: arbitrarily long git stderr lines (for instance, a multi-kilobyte
// server-side pre-receive hook message) should not blow up the toast. Cap the
// detail length so the toast stays readable; the underlying error is still
// rethrown for console/logs if a caller needs the full payload.
function truncateDetail(detail: string): string {
  if (detail.length <= REMOTE_OPERATION_DETAIL_MAX_LENGTH) {
    return detail
  }
  return `${detail.slice(0, REMOTE_OPERATION_DETAIL_MAX_LENGTH).trimEnd()}...`
}

function extractPublishFailureDetail(message: string): string | null {
  const normalized = message.replace(/\r\n/g, '\n')
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const fatalLine = lines.find((line) => line.startsWith('fatal:'))
  if (fatalLine) {
    return truncateDetail(stripCredentialsFromMessage(fatalLine.slice('fatal:'.length).trim()))
  }
  const remoteLine = lines.find((line) => line.startsWith('remote:'))
  if (remoteLine) {
    return truncateDetail(stripCredentialsFromMessage(remoteLine.slice('remote:'.length).trim()))
  }
  return null
}

function resolveRemoteOperationErrorMessage(
  error: unknown,
  options?: { publish?: boolean; isPush?: boolean; isSync?: boolean }
): string {
  if (!(error instanceof Error)) {
    return REMOTE_OPERATION_FAILED_MESSAGE
  }

  // Why: under sync, the inner push runs *after* a successful pull, so a
  // non-fast-forward at that point means the remote raced ahead between
  // fetch and push — not "user forgot to pull". Saying "Pull first" would
  // be wrong (sync just did). Branch isSync above the shared NFF path so
  // sync gets a sync-shaped message instead of inheriting the push wording.
  if (
    options?.isSync &&
    /non-fast-forward|fetch first|updates were rejected/i.test(error.message)
  ) {
    return 'Sync failed — remote moved while syncing. Try again.'
  }

  // Why: non-fast-forward/rejected detection is shared across publish and push so
  // both paths surface the same actionable toast regardless of operation type.
  if (/non-fast-forward|fetch first|updates were rejected/i.test(error.message)) {
    return 'Push rejected — remote has changes. Pull first, then try again.'
  }

  // Why: `git pull` / merge refuses to run when the working tree has changes
  // that would be overwritten; surface a single readable line instead of the
  // multi-line git stderr (which lists every affected path).
  if (
    /local changes.*would be overwritten|Please commit your changes or stash them/i.test(
      error.message
    )
  ) {
    return 'Pull blocked — commit or stash your local changes first.'
  }

  if (options?.publish) {
    // Why: publish failures often bubble up as raw wrapped git/IPC payloads; this
    // keeps the toast human-readable while preserving the actionable fatal reason.
    const detail = extractPublishFailureDetail(error.message)
    if (detail) {
      return `Publish Branch failed. ${detail}. Check your remote access and try again.`
    }

    return 'Publish Branch failed. Check your remote access and try again.'
  }

  if (options?.isSync) {
    // Why: the user invoked Sync — surface "Sync failed" rather than leaking
    // the inner-step name ("Push failed"). Detail extraction matches push so
    // auth / protected-branch reasons stay actionable.
    const detail = extractPublishFailureDetail(error.message)
    if (detail) {
      return `Sync failed. ${detail}. Check your remote access and try again.`
    }
    return 'Sync failed. Check your connection and try again.'
  }

  if (options?.isPush) {
    // Why: surfacing fatal/remote lines from git is more actionable than a generic
    // connection message for auth errors, protected branches, etc.
    const detail = extractPublishFailureDetail(error.message)
    if (detail) {
      return `Push failed. ${detail}. Check your remote access and try again.`
    }
    return 'Push failed. Check your connection and try again.'
  }

  return error.message
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

  // Right sidebar
  rightSidebarOpen: false,
  rightSidebarWidth: 280,
  rightSidebarTab: 'explorer',
  activityBarPosition: 'top',
  toggleRightSidebar: () => set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
  setRightSidebarOpen: (open) => set({ rightSidebarOpen: open }),
  setRightSidebarWidth: (width) => set({ rightSidebarWidth: width }),
  setRightSidebarTab: (tab) => set({ rightSidebarTab: tab }),
  setActivityBarPosition: (position) => set({ activityBarPosition: position }),

  // File explorer
  expandedDirs: {},
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
    set({
      rightSidebarOpen: true,
      rightSidebarTab: 'explorer',
      pendingExplorerReveal: { worktreeId, filePath, requestId: Date.now() }
    }),
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
    set((s) => {
      const id = file.filePath
      const existing = s.openFiles.find((f) => f.id === id)
      const worktreeId = file.worktreeId
      const isPreview = options?.preview ?? false
      const recordReplacedPreview = options?.recordReplacedPreview ?? false
      // Why: resolve the target group up-front so preview replacement can be
      // scoped to that group. Opening as preview in group B must not evict a
      // preview tab belonging to group A (split tab groups).
      const targetGroupId =
        options?.targetGroupId ??
        s.activeGroupIdByWorktree?.[worktreeId] ??
        s.groupsByWorktree?.[worktreeId]?.[0]?.id ??
        undefined
      const previewTabByEntity = new Map<string, string>()
      if (targetGroupId) {
        const tabsForWorktree = s.unifiedTabsByWorktree?.[worktreeId] ?? []
        for (const tab of tabsForWorktree) {
          if (tab.groupId === targetGroupId && tab.isPreview && tab.contentType === 'editor') {
            previewTabByEntity.set(tab.entityId, tab.id)
          }
        }
      }

      const activeResult = {
        activeFileId: id,
        activeTabType: 'editor' as const,
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' as const }
      }

      if (existing) {
        // If opening as non-preview, also pin the existing tab
        const updatedPreview = isPreview ? existing.isPreview : false
        if (
          existing.mode === file.mode &&
          existing.diffSource === file.diffSource &&
          existing.branchCompare?.compareVersion === file.branchCompare?.compareVersion &&
          existing.conflict?.kind === file.conflict?.kind &&
          existing.conflict?.conflictKind === file.conflict?.conflictKind &&
          existing.conflict?.conflictStatus === file.conflict?.conflictStatus &&
          existing.conflictReview?.snapshotTimestamp === file.conflictReview?.snapshotTimestamp &&
          existing.isPreview === updatedPreview
        ) {
          return activeResult
        }
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id
              ? {
                  ...f,
                  mode: file.mode,
                  diffSource: file.diffSource,
                  branchCompare: file.branchCompare,
                  branchOldPath: file.branchOldPath,
                  combinedAlternate: file.combinedAlternate,
                  combinedAreaFilter: file.combinedAreaFilter,
                  conflict: file.conflict,
                  skippedConflicts: file.skippedConflicts,
                  conflictReview: file.conflictReview,
                  isPreview: updatedPreview
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
        const existingPreviewIdx = s.openFiles.findIndex((f) => {
          if (f.worktreeId !== worktreeId || !f.isPreview) {
            return false
          }
          if (previewTabByEntity.size === 0) {
            return true
          }
          return previewTabByEntity.has(f.id)
        })
        if (existingPreviewIdx !== -1) {
          const replacedPreview = s.openFiles[existingPreviewIdx]
          const nextEditorDrafts =
            replacedPreview.id === id
              ? s.editorDrafts
              : Object.fromEntries(
                  Object.entries(s.editorDrafts).filter(([fileId]) => fileId !== replacedPreview.id)
                )
          const nextMarkdownViewMode =
            replacedPreview.id === id
              ? s.markdownViewMode
              : Object.fromEntries(
                  Object.entries(s.markdownViewMode).filter(
                    ([fileId]) => fileId !== replacedPreview.id
                  )
                )
          const nextEditorViewMode =
            replacedPreview.id === id
              ? s.editorViewMode
              : Object.fromEntries(
                  Object.entries(s.editorViewMode).filter(
                    ([fileId]) => fileId !== replacedPreview.id
                  )
                )
          // Why: editorCursorLine entries accumulate per file; clean up the
          // evicted preview's entry so it does not leak across tab replacements.
          const nextEditorCursorLine =
            replacedPreview.id === id
              ? s.editorCursorLine
              : Object.fromEntries(
                  Object.entries(s.editorCursorLine).filter(
                    ([fileId]) => fileId !== replacedPreview.id
                  )
                )
          // Replace in-place to preserve tab position
          newFiles = s.openFiles.map((f, i) =>
            i === existingPreviewIdx ? { ...file, id, isDirty: false, isPreview: true } : f
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
            const { id: _rid, isDirty: _rdirty, ...snap } = replacedPreview
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
          { ...file, id, isDirty: false, isPreview: isPreview || undefined }
        ],
        ...tabBarUpdate,
        ...activeResult
      }
    })
    void openWorkspaceEditorItem(
      get(),
      file.filePath,
      file.worktreeId,
      file.relativePath,
      file.mode === 'conflict-review'
        ? 'conflict-review'
        : file.mode === 'diff'
          ? 'diff'
          : 'editor',
      options?.preview ?? false,
      options?.targetGroupId
    )
  },

  openMarkdownPreview: (file, options) => {
    const id = `markdown-preview::${file.filePath}`
    const anchor = options?.anchor || undefined
    set((s) => {
      const existing = s.openFiles.find((openFile) => openFile.id === id)
      const worktreeId = file.worktreeId
      const activeResult = {
        activeFileId: id,
        activeTabType: 'editor' as const,
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' as const }
      }

      if (existing) {
        const needsUpdate =
          existing.relativePath !== file.relativePath ||
          existing.filePath !== file.filePath ||
          existing.language !== file.language ||
          existing.markdownPreviewSourceFileId !== file.filePath ||
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
                      markdownPreviewSourceFileId: file.filePath,
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
        markdownPreviewSourceFileId: file.filePath,
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

  pinFile: (fileId, tabId) => {
    set((s) => {
      const file = s.openFiles.find((f) => f.id === fileId)
      if (!file?.isPreview) {
        return s
      }
      return {
        openFiles: s.openFiles.map((f) => (f.id === fileId ? { ...f, isPreview: undefined } : f))
      }
    })
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
    const shouldDeleteFromDisk = preClose?.isUntitled === true && !preClose.isDirty && !hasDraft

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
        const { id: _id, isDirty: _dirty, ...snap } = closedFile
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
      void window.api?.fs?.deletePath({ targetPath: preClose.filePath })?.catch(() => {})
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
            entry.contentType === 'conflict-review')
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
        f.isUntitled === true &&
        !f.isDirty &&
        !state.editorDrafts[f.id] &&
        (!activeWorktreeId || f.worktreeId === activeWorktreeId)
    )

    const closingItemIds = Object.values(state.unifiedTabsByWorktree ?? {})
      .flat()
      .filter(
        (item) =>
          (item.contentType === 'editor' ||
            item.contentType === 'diff' ||
            item.contentType === 'conflict-review') &&
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

      // Why: remove all closed editor file IDs from tab bar order so stale
      // entries don't cause position shifts on subsequent tab operations.
      const closedFileIds = new Set(
        s.openFiles.filter((f) => f.worktreeId === activeWorktreeId).map((f) => f.id)
      )
      const nextTabBarOrderByWorktree = s.tabBarOrderByWorktree
        ? {
            ...s.tabBarOrderByWorktree,
            [activeWorktreeId]: (s.tabBarOrderByWorktree[activeWorktreeId] ?? []).filter(
              (entryId) => !closedFileIds.has(entryId)
            )
          }
        : s.tabBarOrderByWorktree

      const closingFiles = s.openFiles.filter((f) => f.worktreeId === activeWorktreeId)
      let nextRecentClosed = s.recentlyClosedEditorTabsByWorktree[activeWorktreeId] ?? []
      for (const f of [...closingFiles].reverse()) {
        // Why: untitled non-dirty files are deleted from disk after close —
        // skip them so the reopen stack doesn't reference vanished paths.
        // Preview tabs are ephemeral views that shouldn't pollute the stack.
        if ((f.isUntitled && !f.isDirty) || f.mode === 'markdown-preview') {
          continue
        }
        const { id: _id, isDirty: _dirty, ...snap } = f
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
      for (const f of untitledToDelete) {
        void window.api?.fs?.deletePath({ targetPath: f.filePath })?.catch(() => {})
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
      return {
        openFiles: s.openFiles.map((f) =>
          f.id === fileId
            ? { ...f, isDirty: dirty, ...(needsPreviewClear ? { isPreview: undefined } : {}) }
            : f
        )
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

  openDiff: (worktreeId, filePath, relativePath, language, staged) => {
    set((s) => {
      const diffSource: DiffSource = staged ? 'staged' : 'unstaged'
      const id = `${worktreeId}::diff::${diffSource}::${relativePath}`
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        const needsUpdate = existing.mode !== 'diff' || existing.diffSource !== diffSource
        return {
          openFiles: needsUpdate
            ? s.openFiles.map((f) =>
                f.id === id
                  ? {
                      ...f,
                      mode: 'diff' as const,
                      diffSource,
                      conflict: undefined,
                      skippedConflicts: undefined,
                      conflictReview: undefined
                    }
                  : f
              )
            : s.openFiles,
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
        conflictReview: undefined
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
      `${worktreeId}::diff::${staged ? 'staged' : 'unstaged'}::${relativePath}`,
      worktreeId,
      relativePath,
      'diff'
    )
  },

  openBranchDiff: (worktreeId, worktreePath, entry, compare, language) => {
    const branchCompare = toBranchCompareSnapshot(compare)
    const id = `${worktreeId}::diff::branch::${compare.baseRef}::${branchCompare.compareVersion}::${entry.path}`
    set((s) => {
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id
              ? {
                  ...f,
                  mode: 'diff' as const,
                  diffSource: 'branch' as const,
                  branchCompare,
                  branchOldPath: entry.oldPath,
                  conflict: undefined,
                  skippedConflicts: undefined,
                  conflictReview: undefined
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
        conflictReview: undefined
      }
      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    })
    void openWorkspaceEditorItem(get(), id, worktreeId, entry.path, 'diff')
  },

  openAllDiffs: (worktreeId, worktreePath, alternate, areaFilter) => {
    const id = areaFilter
      ? `${worktreeId}::all-diffs::uncommitted::${areaFilter}`
      : `${worktreeId}::all-diffs::uncommitted`
    const label = areaFilter
      ? ({ staged: 'Staged Changes', unstaged: 'Changes', untracked: 'Untracked Files' }[
          areaFilter
        ] ?? 'All Changes')
      : 'All Changes'
    set((s) => {
      const relevantEntries = (s.gitStatusByWorktree[worktreeId] ?? []).filter((entry) => {
        if (areaFilter) {
          return entry.area === areaFilter
        }
        return entry.area !== 'untracked'
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
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id
              ? {
                  ...f,
                  uncommittedEntriesSnapshot,
                  combinedAlternate: alternate,
                  combinedAreaFilter: areaFilter,
                  skippedConflicts,
                  conflictReview: undefined,
                  conflict: undefined
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
        diffSource: 'combined-uncommitted',
        uncommittedEntriesSnapshot,
        combinedAlternate: alternate,
        combinedAreaFilter: areaFilter,
        skippedConflicts,
        conflictReview: undefined,
        conflict: undefined
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

  openConflictFile: (worktreeId, worktreePath, entry, language) => {
    const absolutePath = joinPath(worktreePath, entry.path)
    set((s) => {
      const id = absolutePath
      const conflict = toOpenConflictMetadata(entry)
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
                  conflictReview: undefined
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
        conflict
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
    void openWorkspaceEditorItem(get(), absolutePath, worktreeId, entry.path, 'editor')
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

  openBranchAllDiffs: (worktreeId, worktreePath, compare, alternate) => {
    const branchCompare = toBranchCompareSnapshot(compare)
    const id = `${worktreeId}::all-diffs::branch::${compare.baseRef}::${branchCompare.compareVersion}`
    set((s) => {
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
                  conflictReview: undefined
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
        conflictReview: undefined
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

  // Cursor line tracking
  editorCursorLine: {},
  setEditorCursorLine: (fileId, line) =>
    set((s) => ({
      editorCursorLine: { ...s.editorCursorLine, [fileId]: line }
    })),

  // Git status
  gitStatusByWorktree: {},
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
      const statusUnchanged = areGitStatusEntriesEqual(prevEntries, nextEntries)
      const trackedUnchanged = areTrackedConflictMapsEqual(
        s.trackedConflictPathsByWorktree[worktreeId] ?? {},
        currentTracked
      )
      const openFilesUnchanged = nextOpenFiles === s.openFiles
      const operationUnchanged = prevOperation === status.conflictOperation

      if (statusUnchanged && trackedUnchanged && openFilesUnchanged && operationUnchanged) {
        return s
      }

      return {
        openFiles: nextOpenFiles,
        gitStatusByWorktree: statusUnchanged
          ? s.gitStatusByWorktree
          : { ...s.gitStatusByWorktree, [worktreeId]: nextEntries },
        gitConflictOperationByWorktree: operationUnchanged
          ? s.gitConflictOperationByWorktree
          : { ...s.gitConflictOperationByWorktree, [worktreeId]: status.conflictOperation },
        trackedConflictPathsByWorktree: trackedUnchanged
          ? s.trackedConflictPathsByWorktree
          : { ...s.trackedConflictPathsByWorktree, [worktreeId]: currentTracked }
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
    set((s) => ({
      remoteStatusesByWorktree: {
        ...s.remoteStatusesByWorktree,
        [worktreeId]: status
      }
    })),
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
  fetchUpstreamStatus: async (worktreeId, worktreePath, connectionId) => {
    try {
      const status = await window.api.git.upstreamStatus({
        worktreePath,
        connectionId
      })
      get().setUpstreamStatus(worktreeId, status)
    } catch (error) {
      // Why: on error we leave the prior status in place rather than writing a
      // synthetic {hasUpstream:false} — that would flash 'Publish Branch' on a
      // tracked branch after any transient IPC hiccup and a user click would
      // re-publish, clobbering the upstream relationship. If the branch is
      // genuinely newly unpublished, the polling effect will eventually correct
      // the status on success.
      console.error('fetchUpstreamStatus failed', error)
    }
  },
  pushBranch: async (worktreeId, worktreePath, publish = false, connectionId) => {
    // Why: don't *await* a post-op git status / upstream refresh here.
    // Chaining awaited refreshes inside the mutation extends the gap before
    // compound flows (runCompoundCommitAction → runRemoteAction) reach the
    // next step. But we still need a near-immediate upstream refresh so
    // the primary button label rotates from "Push" to "Commit" as soon as
    // ahead=0 — the polling layer is on a 3s interval, which is long
    // enough to read as a stuck label. Solution: fire the upstream refresh
    // as fire-and-forget so it doesn't block the mutation but updates the
    // store as soon as the IPC resolves.
    get().beginRemoteOperation(publish ? 'publish' : 'push')
    try {
      await window.api.git.push({ worktreePath, publish, connectionId })
    } catch (error) {
      toast.error(resolveRemoteOperationErrorMessage(error, { publish, isPush: true }))
      throw error
    } finally {
      get().endRemoteOperation()
    }
    void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId)
  },
  pullBranch: async (worktreeId, worktreePath, connectionId) => {
    get().beginRemoteOperation('pull')
    try {
      await window.api.git.pull({ worktreePath, connectionId })
    } catch (error) {
      toast.error(resolveRemoteOperationErrorMessage(error))
      throw error
    } finally {
      get().endRemoteOperation()
    }
    void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId)
  },
  syncBranch: async (worktreeId, worktreePath, connectionId) => {
    // Why: same shape as pushBranch / pullBranch — fire-and-forget the
    // post-op upstream refresh after the busy flag clears so the primary
    // button label rotates immediately when the IPC resolves.
    get().beginRemoteOperation('sync')
    // Why: the inner push stage toasts with { isSync: true } so its failure
    // surfaces a "Sync failed..." message instead of "Push failed..." — the
    // user invoked Sync; the underlying push is implementation detail. The
    // outer catch must then skip toasting to avoid a double-toast.
    let pushStageToastShown = false
    try {
      await window.api.git.fetch({ worktreePath, connectionId })
      await window.api.git.pull({ worktreePath, connectionId })
      // Why: push only if the pull left local commits that aren't on the
      // remote. After a merge pull the ahead count can be >0 (local commits +
      // the new merge commit) or 0 (pure fast-forward), and we avoid a
      // no-op push round-trip in the fast-forward case.
      const upstreamStatus = await window.api.git.upstreamStatus({
        worktreePath,
        connectionId
      })
      if (upstreamStatus.ahead > 0) {
        try {
          await window.api.git.push({ worktreePath, connectionId })
        } catch (error) {
          // Why: format under the user-facing operation (sync) rather than
          // the inner step (push) — the user clicked Sync and shouldn't see
          // a "Push failed" toast for a step they didn't directly invoke.
          toast.error(resolveRemoteOperationErrorMessage(error, { isSync: true }))
          pushStageToastShown = true
          throw error
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
    void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId)
  },
  fetchBranch: async (worktreeId, worktreePath, connectionId) => {
    // Why: same shape as pushBranch / pullBranch — fire-and-forget the
    // upstream refresh after the busy flag clears. Fetch updates the
    // remote refs only, so the visible signal we want is the new
    // ahead/behind counts on the upstream-status payload.
    get().beginRemoteOperation('fetch')
    try {
      await window.api.git.fetch({ worktreePath, connectionId })
    } catch (error) {
      toast.error(resolveRemoteOperationErrorMessage(error))
      throw error
    } finally {
      get().endRemoteOperation()
    }
    void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId)
  },
  gitBranchChangesByWorktree: {},
  gitBranchCompareSummaryByWorktree: {},
  gitBranchCompareRequestKeyByWorktree: {},
  beginGitBranchCompareRequest: (worktreeId, requestKey, baseRef) =>
    set((s) => ({
      gitBranchCompareRequestKeyByWorktree: {
        ...s.gitBranchCompareRequestKeyByWorktree,
        [worktreeId]: requestKey
      },
      gitBranchCompareSummaryByWorktree: {
        ...s.gitBranchCompareSummaryByWorktree,
        [worktreeId]: {
          baseRef,
          baseOid: null,
          compareRef: 'HEAD',
          headOid: null,
          mergeBase: null,
          changedFiles: 0,
          status: 'loading'
        }
      }
    })),
  setGitBranchCompareResult: (worktreeId, requestKey, result) =>
    set((s) => {
      if (s.gitBranchCompareRequestKeyByWorktree[worktreeId] !== requestKey) {
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

  // File search
  fileSearchStateByWorktree: {},
  updateFileSearchState: (worktreeId, updates) =>
    set((s) => {
      const current = s.fileSearchStateByWorktree[worktreeId] || {
        query: '',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
        includePattern: '',
        excludePattern: '',
        results: null,
        loading: false,
        collapsedFiles: new Set()
      }
      return {
        fileSearchStateByWorktree: {
          ...s.fileSearchStateByWorktree,
          [worktreeId]: { ...current, ...updates }
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
      if (target.relativePath === undefined) {
        // Why: terminal file links already authorize clicked external paths
        // before opening them in Orca. Markdown file:// links need the same
        // user-gesture authorization so /tmp screenshots can use ImageViewer.
        await window.api.fs.authorizeExternalPath({ targetPath: target.absolutePath })
      }

      get().openFile(
        {
          filePath: target.absolutePath,
          relativePath: target.relativePath ?? target.absolutePath,
          worktreeId: ctx.worktreeId,
          language: detectLanguage(target.absolutePath),
          mode: 'edit'
        },
        {
          preview: true,
          targetGroupId: get().activeGroupIdByWorktree?.[ctx.worktreeId],
          recordReplacedPreview: true
        }
      )
      return
    }

    // target.kind === 'markdown'
    const { absolutePath, relativePath, line, column } = target
    const exists = await window.api.shell.pathExists(absolutePath)
    if (!exists) {
      toast.error(`File not found: ${relativePath}`)
      return
    }

    const state = get()
    const existing = state.openFiles.find((f) => f.filePath === absolutePath)
    const fileId = existing?.id ?? absolutePath

    // Why: pendingEditorReveal is consumed by MonacoEditor on mount. If the
    // file opens/stays in rich mode, the reveal is silently dropped. Flip to
    // source before openFile/setActiveFile so Monaco is the surface that
    // mounts or is already mounted when the reveal lands. Rich-mode line
    // reveal is tracked as a follow-up (design doc §open-q 1).
    if (line !== undefined) {
      get().setMarkdownViewMode(fileId, 'source')
    }

    if (!existing) {
      get().openFile(
        {
          filePath: absolutePath,
          relativePath,
          worktreeId: ctx.worktreeId,
          language: 'markdown',
          mode: 'edit'
        },
        {
          preview: true,
          targetGroupId: get().activeGroupIdByWorktree?.[ctx.worktreeId],
          recordReplacedPreview: true
        }
      )
    } else {
      get().setActiveFile(existing.id)
    }

    if (line !== undefined) {
      // Why: double-RAF matches search-match-open.ts. openFile may replace a
      // preview, remounting Monaco asynchronously; the mount's own
      // setPendingEditorReveal(null) would otherwise clobber a reveal scheduled
      // in the same tick.
      get().setPendingEditorReveal(null)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          get().setPendingEditorReveal({
            filePath: absolutePath,
            line,
            column: column ?? 1,
            matchLength: 0
          })
        })
      })
    }
  },

  // Why: only edit-mode files are restored — diffs and conflict views depend on
  // transient git state that may have changed between sessions. Restoring them
  // would show stale data or fail to load entirely.
  hydrateEditorSession: (session) => {
    set((s) => {
      const openFilesByWorktree = session.openFilesByWorktree ?? {}
      const persistedActiveFileIdByWorktree = session.activeFileIdByWorktree ?? {}
      const persistedActiveTabTypeByWorktree = session.activeTabTypeByWorktree ?? {}

      // Why: worktrees may have been deleted between sessions. Filter out
      // files for worktrees that no longer exist, mirroring the validation
      // that hydrateWorkspaceSession performs for terminal tabs.
      const validWorktreeIds = new Set(
        Object.values(s.worktreesByRepo)
          .flat()
          .map((w) => w.id)
      )

      const openFiles: OpenFile[] = []
      for (const [worktreeId, files] of Object.entries(openFilesByWorktree)) {
        if (!validWorktreeIds.has(worktreeId)) {
          continue
        }
        for (const pf of files) {
          openFiles.push({
            id: pf.filePath,
            filePath: pf.filePath,
            relativePath: pf.relativePath,
            worktreeId,
            language: pf.language,
            isDirty: false,
            isPreview: pf.isPreview,
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
        ? (persistedActiveFileIdByWorktree[activeWorktreeId] ?? null)
        : null
      // Why: verify the persisted active file still exists in the restored set.
      // The file may have been removed due to worktree validation or the
      // persisted data may reference a stale path.
      const activeFileExists = persistedActiveFileId
        ? openFiles.some((f) => f.id === persistedActiveFileId)
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
          const persistedFileId = persistedActiveFileIdByWorktree[wId]
          if (persistedFileId && openFiles.some((f) => f.id === persistedFileId)) {
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

      return {
        openFiles,
        activeFileId: nextActiveFileId,
        activeFileIdByWorktree: filteredActiveFileIdByWorktree,
        activeTabType: nextActiveTabType,
        activeTabTypeByWorktree: filteredActiveTabTypeByWorktree
      }
    })
  }
})

function getCompareVersion(
  compare: Pick<GitBranchCompareSummary, 'baseOid' | 'headOid' | 'mergeBase'>
): string {
  return [
    compare.baseOid ?? 'no-base',
    compare.headOid ?? 'no-head',
    compare.mergeBase ?? 'no-merge-base'
  ].join(':')
}

function toBranchCompareSnapshot(compare: GitBranchCompareSummary): BranchCompareSnapshot {
  return {
    baseRef: compare.baseRef,
    baseOid: compare.baseOid,
    compareRef: compare.compareRef,
    headOid: compare.headOid,
    mergeBase: compare.mergeBase,
    compareVersion: getCompareVersion(compare)
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
        message: 'This file is in a conflict state, but no working-tree file is available to edit.',
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
        entry.conflictStatusSource === next[index].conflictStatusSource
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

    if (file.mode === 'conflict-review') {
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
