import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { ownsGlobalSelection } from '../../../global-selection-owner'
import { EMPTY_EDITOR_BUFFER_VIEW_INDEX } from '../buffers/editor-buffer-views'

export function createOpenFileState(
  set: EditorSet,
  _get: EditorGet
): Pick<
  EditorSlice,
  | 'openFiles'
  | 'editorBuffers'
  | 'editorBufferIdOf'
  | 'editorBufferViews'
  | 'editorBufferDetached'
  | 'editorBufferKept'
  | 'editorBufferIdentityRevision'
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'activeTabType'
  | 'recentlyClosedEditorTabsByWorktree'
  | 'setActiveTabType'
> {
  return {
    openFiles: [],
    editorBuffers: {},
    ...EMPTY_EDITOR_BUFFER_VIEW_INDEX,
    editorBufferDetached: {},
    editorBufferKept: {},
    editorBufferIdentityRevision: 0,
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
