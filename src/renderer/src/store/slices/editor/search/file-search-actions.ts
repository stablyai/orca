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
        const base = existing || defaultFileSearchState()
        const next = { ...base, ...updates }
        // Switching workspaces cancels the outgoing idle search; a no-op write would re-notify every subscriber.
        // Why: a cancel after a workspace is purged must not recreate its entry.
        if (shallow(base, next)) {
          return s
        }
        return {
          fileSearchStateByWorktree: {
            ...s.fileSearchStateByWorktree,
            [worktreeId]: next
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
