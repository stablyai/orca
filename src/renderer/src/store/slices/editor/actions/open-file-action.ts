import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'
import type { EditorTabContentType } from '../tabs/editor-tab-content-type'
import {
  EDITOR_FOCUS_REQUEST_TTL_MS,
  takeNextEditorFocusRequestToken
} from '../focus/editor-focus-reveal'
import { applyOpenFileToState } from './open-file-apply'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { recordReopenedEditorFileInLayoutOwner } from '../tabs/editor-tab-layout-owner'

export function createOpenFileAction(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openFile'> {
  return {
    openFile: (file, options) => {
      const editorItemWorktreeId = file.worktreeId
      const editorItemLabel = file.relativePath
      const editorItemContentType: EditorTabContentType =
        file.mode === 'conflict-review' || file.mode === 'check-details' || file.mode === 'diff'
          ? file.mode
          : 'editor'
      const scratch = {
        editorItemFileId: file.filePath,
        editorItemTargetGroupId: options?.targetGroupId,
        editorItemIsPreview: false
      }
      const before = ORCA_LAYOUT_OWNER_IS_MAIN ? get() : null
      set((s) => applyOpenFileToState(s, file, options, scratch))
      const editorItemViewStateId = openWorkspaceEditorItem(
        get(),
        scratch.editorItemFileId,
        editorItemWorktreeId,
        editorItemLabel,
        editorItemContentType,
        scratch.editorItemIsPreview,
        scratch.editorItemTargetGroupId,
        options?.selection
      )
      if (ORCA_LAYOUT_OWNER_IS_MAIN && before) {
        recordReopenedEditorFileInLayoutOwner(
          before,
          get(),
          editorItemWorktreeId,
          editorItemViewStateId
        )
      }
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
