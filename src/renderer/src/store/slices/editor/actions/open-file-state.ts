import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { ownsGlobalSelection } from '../../../global-selection-owner'

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
    // Why the worktree is required: an implicit "active worktree" default let callers retype the
    // main window while acting on a tab that lives elsewhere (e.g. the floating workspace).
    setActiveTabType: (type, worktreeId) =>
      set((s) => ({
        ...(ownsGlobalSelection(s, worktreeId) ? { activeTabType: type } : {}),
        activeTabTypeByWorktree: worktreeId
          ? { ...s.activeTabTypeByWorktree, [worktreeId]: type }
          : s.activeTabTypeByWorktree
      }))
  }
}
