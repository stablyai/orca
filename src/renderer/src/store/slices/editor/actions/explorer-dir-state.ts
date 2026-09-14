import type { EditorGet, EditorSet } from '../types/editor-set-get'
import { isPathInsideOrEqual } from '../../../../../../shared/cross-platform-path'

export type ExplorerDirState = {
  expandedDirs: Record<string, Set<string>>
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
}

export function createExplorerDirState(set: EditorSet, _get: EditorGet): ExplorerDirState {
  return {
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
    clearPendingExplorerReveal: () => set({ pendingExplorerReveal: null })
  }
}
