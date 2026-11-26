import { shallow } from 'zustand/shallow'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { defaultFileSearchState } from './file-search-state'

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
  | 'consumeFileSearchFocusRequest'
  | 'toggleFileSearchCollapsedFile'
  | 'clearFileSearch'
> {
  return {
    fileSearchStateByWorktree: {},
    updateFileSearchState: (worktreeId, updates) =>
      set((s) => {
        const existing = s.fileSearchStateByWorktree[worktreeId]
        const next = { ...(existing || defaultFileSearchState()), ...updates }
        // Switching workspaces cancels the outgoing idle search; a no-op write would re-notify every subscriber.
        if (existing && shallow(existing, next)) {
          return s
        }
        return {
          fileSearchStateByWorktree: {
            ...s.fileSearchStateByWorktree,
            [worktreeId]: next
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
              error: null,
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
              error: null,
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
        delete next.seedKind
        return {
          fileSearchStateByWorktree: {
            ...s.fileSearchStateByWorktree,
            [worktreeId]: next
          }
        }
      }),
    consumeFileSearchFocusRequest: (worktreeId, focusRequestId) =>
      set((s) => {
        const current = s.fileSearchStateByWorktree[worktreeId]
        if (!current || current.focusRequestId !== focusRequestId) {
          return s
        }
        const next = { ...current }
        delete next.focusRequestId
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
        // Why: clearing an already empty search must not clone the per-worktree map on every key.
        if (
          !current ||
          (!current.query &&
            !current.results &&
            !current.resultOwner &&
            !current.loading &&
            !current.error &&
            current.collapsedFiles.size === 0)
        ) {
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
              error: null,
              collapsedFiles: new Set()
            }
          }
        }
      })
  }
}
