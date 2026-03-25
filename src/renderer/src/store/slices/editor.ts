/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitStatusEntry, SearchResult } from '../../../../shared/types'

export type OpenFile = {
  id: string // use filePath as unique key
  filePath: string // absolute path
  relativePath: string // relative to worktree root
  worktreeId: string
  language: string
  isDirty: boolean
  mode: 'edit' | 'diff'
  diffStaged?: boolean
}

export type RightSidebarTab = 'explorer' | 'search' | 'source-control'
export type ActivityBarPosition = 'top' | 'side'

export type EditorSlice = {
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

  // Open files / editor tabs
  openFiles: OpenFile[]
  activeFileId: string | null
  activeFileIdByWorktree: Record<string, string | null> // worktreeId -> last active file
  activeTabTypeByWorktree: Record<string, 'terminal' | 'editor'> // worktreeId -> last active tab type
  activeTabType: 'terminal' | 'editor'
  setActiveTabType: (type: 'terminal' | 'editor') => void
  openFile: (file: Omit<OpenFile, 'id' | 'isDirty'>) => void
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
  openAllDiffs: (worktreeId: string, worktreePath: string) => void

  // Cursor line tracking per file
  editorCursorLine: Record<string, number>
  setEditorCursorLine: (fileId: string, line: number) => void

  // Git status cache
  gitStatusByWorktree: Record<string, GitStatusEntry[]>
  setGitStatus: (worktreeId: string, entries: GitStatusEntry[]) => void

  // File search state
  fileSearchQuery: string
  fileSearchCaseSensitive: boolean
  fileSearchWholeWord: boolean
  fileSearchUseRegex: boolean
  fileSearchIncludePattern: string
  fileSearchExcludePattern: string
  fileSearchResults: SearchResult | null
  fileSearchLoading: boolean
  fileSearchCollapsedFiles: Set<string>
  setFileSearchQuery: (query: string) => void
  setFileSearchCaseSensitive: (v: boolean) => void
  setFileSearchWholeWord: (v: boolean) => void
  setFileSearchUseRegex: (v: boolean) => void
  setFileSearchIncludePattern: (v: string) => void
  setFileSearchExcludePattern: (v: string) => void
  setFileSearchResults: (results: SearchResult | null) => void
  setFileSearchLoading: (loading: boolean) => void
  toggleFileSearchCollapsedFile: (filePath: string) => void
  clearFileSearch: () => void

  // Editor navigation (for search result → go-to-line)
  pendingEditorReveal: { line: number; column: number; matchLength: number } | null
  setPendingEditorReveal: (
    reveal: { line: number; column: number; matchLength: number } | null
  ) => void
}

export const createEditorSlice: StateCreator<AppState, [], [], EditorSlice> = (set) => ({
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

  openFile: (file) =>
    set((s) => {
      const id = file.filePath
      const existing = s.openFiles.find((f) => f.id === id)
      const worktreeId = file.worktreeId
      if (existing) {
        if (existing.mode === file.mode && existing.diffStaged === file.diffStaged) {
          return {
            activeFileId: id,
            activeTabType: 'editor',
            activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
            activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
          }
        }
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id ? { ...f, mode: file.mode, diffStaged: file.diffStaged } : f
          ),
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }
      return {
        openFiles: [...s.openFiles, { ...file, id, isDirty: false }],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    }),

  closeFile: (fileId) =>
    set((s) => {
      const closedFile = s.openFiles.find((f) => f.id === fileId)
      const idx = s.openFiles.findIndex((f) => f.id === fileId)
      const newFiles = s.openFiles.filter((f) => f.id !== fileId)
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
        activeFileId: newActiveId,
        activeTabType: newActiveTabType,
        activeFileIdByWorktree: newActiveFileIdByWorktree,
        activeTabTypeByWorktree: newActiveTabTypeByWorktree,
        pendingEditorReveal: null
      }
    }),

  closeAllFiles: () =>
    set((s) => {
      const activeWorktreeId = s.activeWorktreeId
      if (!activeWorktreeId) {
        return { openFiles: [], activeFileId: null, activeTabType: 'terminal' }
      }
      // Only close files for the current worktree
      const newFiles = s.openFiles.filter((f) => f.worktreeId !== activeWorktreeId)
      const newActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
      delete newActiveFileIdByWorktree[activeWorktreeId]
      const newActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
      newActiveTabTypeByWorktree[activeWorktreeId] = 'terminal'
      return {
        openFiles: newFiles,
        activeFileId: null,
        activeTabType: 'terminal',
        activeFileIdByWorktree: newActiveFileIdByWorktree,
        activeTabTypeByWorktree: newActiveTabTypeByWorktree
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
      openFiles: s.openFiles.map((f) => (f.id === fileId ? { ...f, isDirty: dirty } : f))
    })),

  openDiff: (worktreeId, filePath, relativePath, language, staged) =>
    set((s) => {
      const id = `${filePath}${staged ? '::staged' : ''}`
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        return {
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
        diffStaged: staged
      }
      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    }),

  openAllDiffs: (worktreeId, worktreePath) =>
    set((s) => {
      const id = `${worktreeId}::all-diffs`
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        return {
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }
      const newFile: OpenFile = {
        id,
        filePath: worktreePath,
        relativePath: 'All Changes',
        worktreeId,
        language: 'plaintext',
        isDirty: false,
        mode: 'diff',
        diffStaged: undefined
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
  setGitStatus: (worktreeId, entries) =>
    set((s) => ({
      gitStatusByWorktree: { ...s.gitStatusByWorktree, [worktreeId]: entries }
    })),

  // File search
  fileSearchQuery: '',
  fileSearchCaseSensitive: false,
  fileSearchWholeWord: false,
  fileSearchUseRegex: false,
  fileSearchIncludePattern: '',
  fileSearchExcludePattern: '',
  fileSearchResults: null,
  fileSearchLoading: false,
  fileSearchCollapsedFiles: new Set<string>(),
  setFileSearchQuery: (query) => set({ fileSearchQuery: query }),
  setFileSearchCaseSensitive: (v) => set({ fileSearchCaseSensitive: v }),
  setFileSearchWholeWord: (v) => set({ fileSearchWholeWord: v }),
  setFileSearchUseRegex: (v) => set({ fileSearchUseRegex: v }),
  setFileSearchIncludePattern: (v) => set({ fileSearchIncludePattern: v }),
  setFileSearchExcludePattern: (v) => set({ fileSearchExcludePattern: v }),
  setFileSearchResults: (results) => set({ fileSearchResults: results }),
  setFileSearchLoading: (loading) => set({ fileSearchLoading: loading }),
  toggleFileSearchCollapsedFile: (filePath) =>
    set((s) => {
      const next = new Set(s.fileSearchCollapsedFiles)
      if (next.has(filePath)) {
        next.delete(filePath)
      } else {
        next.add(filePath)
      }
      return { fileSearchCollapsedFiles: next }
    }),
  clearFileSearch: () =>
    set({
      fileSearchQuery: '',
      fileSearchResults: null,
      fileSearchLoading: false,
      fileSearchCollapsedFiles: new Set<string>()
    }),

  // Editor navigation
  pendingEditorReveal: null,
  setPendingEditorReveal: (reveal) => set({ pendingEditorReveal: reveal })
})
