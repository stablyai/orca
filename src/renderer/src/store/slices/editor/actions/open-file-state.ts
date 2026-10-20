import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { ownsGlobalSelection } from '../../../global-selection-owner'
import { EMPTY_EDITOR_BUFFER_INDEX } from '../buffers/editor-buffer-record'
import {
  appendRecoveredEditorDrafts,
  isSameRecoveredEditorDraft
} from '../buffers/recovered-editor-drafts'

export function createOpenFileState(
  set: EditorSet,
  _get: EditorGet
): Pick<
  EditorSlice,
  | 'openFiles'
  | 'editorBuffers'
  | 'editorBufferIndex'
  | 'recoveredEditorDrafts'
  | 'dismissRecoveredEditorDraft'
  | 'addRecoveredEditorDrafts'
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
    editorBufferIndex: EMPTY_EDITOR_BUFFER_INDEX,
    recoveredEditorDrafts: [],
    addRecoveredEditorDrafts: (drafts) =>
      set((s) => ({
        recoveredEditorDrafts: appendRecoveredEditorDrafts(s.recoveredEditorDrafts, drafts)
      })),
    dismissRecoveredEditorDraft: (draft) =>
      set((s) => ({
        // Why re-cap: a draft held for this launch only may fit once another is dismissed.
        recoveredEditorDrafts: appendRecoveredEditorDrafts(
          s.recoveredEditorDrafts.filter((entry) => !isSameRecoveredEditorDraft(entry, draft)),
          []
        )
      })),
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
