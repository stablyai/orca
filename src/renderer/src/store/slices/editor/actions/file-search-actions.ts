import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { defaultFileSearchState } from '../search/file-search-state'

export function createFileSearchActions(
  set: EditorSet,
  _get: EditorGet
): Pick<
  EditorSlice,
  | 'fileSearchStateByWorktree'
  | 'updateFileSearchState'
  | 'seedFileSearchQuery'
  | 'seedFileSearchIncludePattern'
  | 'consumeFileSearchSeedRequest'
  | 'toggleFileSearchCollapsedFile'
  | 'clearFileSearch'
> {
  return {
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
      })
  }
}
