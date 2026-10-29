import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { ownsGlobalSelection } from '../../../global-selection-owner'
import { EMPTY_EDITOR_BUFFER_VIEW_INDEX } from '../buffers/editor-buffer-views'
import { editSessionSource } from '@/store/session-source-edits'

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
    // Require explicit worktree so background/floating actions cannot retype main-window selection.
    setActiveTabType: (type, worktreeId) =>
      set((s) => {
        const edit = editSessionSource(s)
        if (worktreeId) {
          edit.set('activeTabTypeByWorktree', worktreeId, type)
        }
        return edit.finish(ownsGlobalSelection(s, worktreeId) ? { activeTabType: type } : {})
      })
  }
}
