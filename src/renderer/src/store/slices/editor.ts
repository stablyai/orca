/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { joinPath } from '@/lib/path'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitConflictKind,
  GitConflictOperation,
  GitConflictResolutionStatus,
  GitConflictStatusSource,
  GitStatusEntry,
  GitStatusResult,
  SearchResult,
  WorkspaceSessionState
} from '../../../../shared/types'

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
  diffSource?: DiffSource
  branchCompare?: BranchCompareSnapshot
  branchOldPath?: string
  combinedAlternate?: CombinedDiffAlternate
  combinedAreaFilter?: string // filter combined diff to a specific area (e.g. 'staged', 'unstaged', 'untracked')
  branchEntriesSnapshot?: GitBranchChangeEntry[]
  conflict?: OpenConflictMetadata
  skippedConflicts?: CombinedDiffSkippedConflict[]
  conflictReview?: ConflictReviewState
  isPreview?: boolean // preview tabs are replaced when another file is single-clicked
  mode: 'edit' | 'diff' | 'conflict-review'
}

export type RightSidebarTab = 'explorer' | 'search' | 'source-control' | 'checks'
export type ActivityBarPosition = 'top' | 'side'

export type MarkdownViewMode = 'source' | 'rich'

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
  activeTabTypeByWorktree: Record<string, 'terminal' | 'editor'> // worktreeId -> last active tab type
  activeTabType: 'terminal' | 'editor'
  setActiveTabType: (type: 'terminal' | 'editor') => void
  openFile: (file: Omit<OpenFile, 'id' | 'isDirty'>, options?: { preview?: boolean }) => void
  pinFile: (fileId: string) => void
  closeFile: (fileId: string) => void
  closeAllFiles: () => void
  setActiveFile: (fileId: string) => void
  reorderFiles: (fileIds: string[]) => void
  markFileDirty: (fileId: string, dirty: boolean) => void
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

  // Quick open (Cmd+P)
  quickOpenVisible: boolean
  setQuickOpenVisible: (visible: boolean) => void

  // Session hydration — restore editor files from persisted workspace session
  hydrateEditorSession: (session: WorkspaceSessionState) => void
}

export const createEditorSlice: StateCreator<AppState, [], [], EditorSlice> = (set) => ({
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

  openFile: (file, options) =>
    set((s) => {
      const id = file.filePath
      const existing = s.openFiles.find((f) => f.id === id)
      const worktreeId = file.worktreeId
      const isPreview = options?.preview ?? false

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

      // If opening as preview, replace the existing preview tab for this worktree
      let newFiles = s.openFiles
      if (isPreview) {
        const existingPreviewIdx = s.openFiles.findIndex(
          (f) => f.worktreeId === worktreeId && f.isPreview
        )
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
          return {
            openFiles: newFiles,
            editorDrafts: nextEditorDrafts,
            markdownViewMode: nextMarkdownViewMode,
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
        const allExisting = new Set([...terminalIds, ...editorFileIds])
        const base = currentOrder.filter((eid) => allExisting.has(eid))
        const inBase = new Set(base)
        for (const eid of [...terminalIds, ...editorFileIds]) {
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
    }),

  pinFile: (fileId) =>
    set((s) => {
      const file = s.openFiles.find((f) => f.id === fileId)
      if (!file?.isPreview) {
        return s
      }
      return {
        openFiles: s.openFiles.map((f) => (f.id === fileId ? { ...f, isPreview: undefined } : f))
      }
    }),

  // Why: closing a tab does NOT clear Resolved locally state. If the file is
  // still present in Changes or Staged Changes, the continuity badge should
  // remain visible until the file leaves the sidebar, the session resets, or
  // the file becomes live-unresolved again. trackedConflictPaths is tied to
  // sidebar presence, not tab lifecycle.
  closeFile: (fileId) =>
    set((s) => {
      const closedFile = s.openFiles.find((f) => f.id === fileId)
      const idx = s.openFiles.findIndex((f) => f.id === fileId)
      const newFiles = s.openFiles.filter((f) => f.id !== fileId)
      const newEditorDrafts = { ...s.editorDrafts }
      delete newEditorDrafts[fileId]
      const newMarkdownViewMode = { ...s.markdownViewMode }
      delete newMarkdownViewMode[fileId]
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

      // When last editor file for current worktree is closed, switch back to terminal
      const activeWorktreeId = s.activeWorktreeId
      const remainingForWorktree = activeWorktreeId
        ? newFiles.filter((f) => f.worktreeId === activeWorktreeId)
        : newFiles
      const newActiveTabType = remainingForWorktree.length === 0 ? 'terminal' : s.activeTabType
      const newActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
      if (activeWorktreeId && remainingForWorktree.length === 0) {
        newActiveTabTypeByWorktree[activeWorktreeId] = 'terminal'
      }

      return {
        openFiles: newFiles,
        editorDrafts: newEditorDrafts,
        activeFileId: newActiveId,
        activeTabType: newActiveTabType,
        activeFileIdByWorktree: newActiveFileIdByWorktree,
        activeTabTypeByWorktree: newActiveTabTypeByWorktree,
        markdownViewMode: newMarkdownViewMode,
        pendingEditorReveal: null
      }
    }),

  closeAllFiles: () =>
    set((s) => {
      const activeWorktreeId = s.activeWorktreeId
      if (!activeWorktreeId) {
        return {
          openFiles: [],
          editorDrafts: {},
          activeFileId: null,
          activeTabType: 'terminal',
          markdownViewMode: {},
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
      const newActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
      delete newActiveFileIdByWorktree[activeWorktreeId]
      const newActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
      newActiveTabTypeByWorktree[activeWorktreeId] = 'terminal'
      return {
        openFiles: newFiles,
        editorDrafts: newEditorDrafts,
        activeFileId: null,
        activeTabType: 'terminal',
        markdownViewMode: newMarkdownViewMode,
        activeFileIdByWorktree: newActiveFileIdByWorktree,
        activeTabTypeByWorktree: newActiveTabTypeByWorktree,
        // Why: search-result navigation queues a one-shot reveal for the next
        // editor mount. If the worktree closes all editor tabs before that
        // reveal is consumed, keeping it around would make a later reopen jump
        // to an old match unexpectedly.
        pendingEditorReveal: null
      }
    }),

  setActiveFile: (fileId) =>
    set((s) => {
      const file = s.openFiles.find((f) => f.id === fileId)
      const worktreeId = file?.worktreeId
      return {
        activeFileId: fileId,
        activeFileIdByWorktree: worktreeId
          ? { ...s.activeFileIdByWorktree, [worktreeId]: fileId }
          : s.activeFileIdByWorktree
      }
    }),

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
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.id === fileId
          ? { ...f, isDirty: dirty, ...(dirty && f.isPreview ? { isPreview: undefined } : {}) }
          : f
      )
    })),

  openDiff: (worktreeId, filePath, relativePath, language, staged) =>
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
    }),

  openBranchDiff: (worktreeId, worktreePath, entry, compare, language) =>
    set((s) => {
      const branchCompare = toBranchCompareSnapshot(compare)
      const id = `${worktreeId}::diff::branch::${compare.baseRef}::${branchCompare.compareVersion}::${entry.path}`
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
    }),

  openAllDiffs: (worktreeId, worktreePath, alternate, areaFilter) =>
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
    }),

  openConflictFile: (worktreeId, worktreePath, entry, language) =>
    set((s) => {
      const absolutePath = joinPath(worktreePath, entry.path)
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
    }),

  // Why: Review conflicts is launched from Source Control into the editor area,
  // not from Checks. Merge-conflict review is source-control work, not CI/PR
  // status. The tab renders from a stored snapshot (entries + timestamp), not
  // from live status on every paint, so the list is stable even if the live
  // unresolved set changes between polls.
  openConflictReview: (worktreeId, worktreePath, entries, source) =>
    set((s) => {
      const id = `${worktreeId}::conflict-review`
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
    }),

  openBranchAllDiffs: (worktreeId, worktreePath, compare, alternate) =>
    set((s) => {
      const branchCompare = toBranchCompareSnapshot(compare)
      const branchEntriesSnapshot = s.gitBranchChangesByWorktree[worktreeId] ?? []
      const id = `${worktreeId}::all-diffs::branch::${compare.baseRef}::${branchCompare.compareVersion}`
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
    }),

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

  // Quick open
  quickOpenVisible: false,
  setQuickOpenVisible: (visible) => set({ quickOpenVisible: visible }),

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

      if (openFiles.length === 0) {
        return {}
      }

      // Why: use the store's activeWorktreeId (set by hydrateWorkspaceSession)
      // rather than the raw session value. hydrateWorkspaceSession may have
      // nulled out an invalid worktree ID, and we must respect that decision.
      const activeWorktreeId = s.activeWorktreeId
      const activeFileId = activeWorktreeId
        ? (persistedActiveFileIdByWorktree[activeWorktreeId] ?? null)
        : null
      // Why: verify the persisted active file still exists in the restored set.
      // The file may have been removed due to worktree validation or the
      // persisted data may reference a stale path.
      const activeFileExists = activeFileId ? openFiles.some((f) => f.id === activeFileId) : false
      const activeTabType =
        activeWorktreeId && persistedActiveTabTypeByWorktree[activeWorktreeId]
          ? persistedActiveTabTypeByWorktree[activeWorktreeId]
          : 'terminal'

      // Filter per-worktree maps to only valid worktrees with valid file references
      const filteredActiveFileIdByWorktree = Object.fromEntries(
        Object.entries(persistedActiveFileIdByWorktree).filter(
          ([wId, fileId]) =>
            validWorktreeIds.has(wId) && fileId && openFiles.some((f) => f.id === fileId)
        )
      )
      const filteredActiveTabTypeByWorktree = Object.fromEntries(
        Object.entries(persistedActiveTabTypeByWorktree).filter(([wId]) =>
          validWorktreeIds.has(wId)
        )
      )

      return {
        openFiles,
        activeFileId: activeFileExists ? activeFileId : null,
        activeFileIdByWorktree: filteredActiveFileIdByWorktree,
        activeTabType: activeFileExists ? activeTabType : 'terminal',
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
