import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import type { OpenFile } from '../types/open-file'
import type { OpenFileOptions } from '../types/editor-files-slice'
import type { EditorOpenLinkIntent, EditorOpenResult } from '../types/editor-open-link-intent'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'
import { editorTabContentTypeForMode } from '../tabs/editor-tab-content-type'
import { isLiveEditorOpenGroup } from '../tabs/editor-open-target-group'
import {
  EDITOR_FOCUS_REQUEST_TTL_MS,
  takeNextEditorFocusRequestToken
} from '../focus/editor-focus-reveal'
import { applyOpenFileToState, type OpenFileApplyScratch } from './open-file-apply'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { recordReopenedEditorFileInLayoutOwner } from '../tabs/editor-tab-layout-owner'

export function createOpenFileAction(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openFile' | 'openFileForLink'> {
  const open = (
    file: Omit<OpenFile, 'id' | 'isDirty'>,
    options: OpenFileOptions | undefined,
    linkIntent: EditorOpenLinkIntent | null
  ): { fileId: string; result: EditorOpenResult | null } => {
    const editorItemWorktreeId = file.worktreeId
    const scratch: OpenFileApplyScratch = {
      editorItemFileId: file.filePath,
      editorItemTargetGroupId: options?.targetGroupId,
      editorItemIsPreview: false,
      refused: false
    }
    const before = ORCA_LAYOUT_OWNER_IS_MAIN ? get() : null
    set((s) => applyOpenFileToState(s, file, options, scratch, linkIntent))
    if (scratch.refused) {
      return { fileId: scratch.editorItemFileId, result: null }
    }
    // Why: a reentrant update may remove the chosen group after selection; never recreate it.
    if (
      linkIntent &&
      scratch.editorItemTargetGroupId &&
      !isLiveEditorOpenGroup(get(), editorItemWorktreeId, scratch.editorItemTargetGroupId)
    ) {
      return { fileId: scratch.editorItemFileId, result: null }
    }
    const editorItemViewStateId = openWorkspaceEditorItem(
      get(),
      scratch.editorItemFileId,
      editorItemWorktreeId,
      file.relativePath,
      editorTabContentTypeForMode(file.mode),
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
    // Why: openWorkspaceEditorItem falls back to the file id when no tab exists; that is not a view.
    const view = (get().unifiedTabsByWorktree?.[editorItemWorktreeId] ?? []).find(
      (tab) => tab.id === editorItemViewStateId && tab.entityId === scratch.editorItemFileId
    )
    return {
      fileId: scratch.editorItemFileId,
      result: view
        ? { fileId: scratch.editorItemFileId, viewStateId: view.id, groupId: view.groupId }
        : null
    }
  }

  return {
    openFile: (file, options) => open(file, options, null).fileId,
    openFileForLink: (file, options, intent) => {
      const { result } = open(file, { ...options, focusEditor: true }, intent)
      // Why: created and reused views must land identically; creating in another group leaves focus behind.
      if (result) {
        get().focusGroup?.(file.worktreeId, result.groupId)
      }
      return result
    }
  }
}
