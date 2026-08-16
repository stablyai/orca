import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'
import {
  EDITOR_FOCUS_REQUEST_TTL_MS,
  takeNextEditorFocusRequestToken
} from '../focus/editor-focus-reveal'
import { applyOpenFileToState } from './open-file-apply'

export function createOpenFileAction(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openFile'> {
  return {
    openFile: (file, options) => {
      const editorItemWorktreeId = file.worktreeId
      const editorItemLabel = file.relativePath
      const editorItemContentType: 'editor' | 'diff' | 'conflict-review' | 'check-details' =
        file.mode === 'conflict-review'
          ? 'conflict-review'
          : file.mode === 'check-details'
            ? 'check-details'
            : file.mode === 'diff'
              ? 'diff'
              : 'editor'
      const scratch = {
        editorItemFileId: file.filePath,
        editorItemTargetGroupId: options?.targetGroupId
      }
      set((s) => applyOpenFileToState(s, file, options, scratch))
      const editorItemViewStateId = openWorkspaceEditorItem(
        get(),
        scratch.editorItemFileId,
        editorItemWorktreeId,
        editorItemLabel,
        editorItemContentType,
        options?.preview ?? false,
        scratch.editorItemTargetGroupId
      )
      if (options?.focusEditor) {
        set({
          pendingEditorFocusRequest: {
            fileId: scratch.editorItemFileId,
            worktreeId: editorItemWorktreeId,
            viewStateId: editorItemViewStateId,
            expiresAt: Date.now() + EDITOR_FOCUS_REQUEST_TTL_MS,
            token: takeNextEditorFocusRequestToken()
          }
        })
      }
      return scratch.editorItemFileId
    }
  }
}
