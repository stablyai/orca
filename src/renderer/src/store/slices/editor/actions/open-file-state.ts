import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'

export function createOpenFileState(
  set: EditorSet,
  _get: EditorGet
): Pick<
  EditorSlice,
  | 'openFiles'
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'activeTabType'
  | 'recentlyClosedEditorTabsByWorktree'
  | 'setActiveTabType'
> {
  return {
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
      })
  }
}
