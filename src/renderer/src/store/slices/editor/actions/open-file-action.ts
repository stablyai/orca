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
import { afterPendingTab, pendingTabGroupId } from '@/runtime/layout-owner-pending-tabs'

export function createOpenFileAction(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openFile' | 'openFileForLink'> {
  const open = (
    file: Omit<OpenFile, 'id' | 'isDirty'>,
    options: OpenFileOptions | undefined,
    linkIntent: EditorOpenLinkIntent | null,
    /** The view once it is drawn; null when none was. */
    onShown?: (result: EditorOpenResult | null) => void
  ): { fileId: string; result: EditorOpenResult | null } => {
    const editorItemWorktreeId = file.worktreeId
    const scratch: OpenFileApplyScratch = {
      editorItemFileId: file.filePath,
      editorItemTargetGroupId: options?.targetGroupId,
      editorItemIsPreview: false,
      refused: false
    }
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
      options?.selection,
      options?.groupIndex
    )
    const settled: { ran: boolean; result: EditorOpenResult | null } = { ran: false, result: null }
    // Why after: a layout-owner build draws a new tab only with main's frame; today's is drawn already.
    afterPendingTab(editorItemViewStateId, (shownId) => {
      settled.ran = true
      if (shownId === null) {
        onShown?.(null)
        return
      }
      if (options?.focusEditor) {
        set({
          pendingEditorFocusRequest: {
            fileId: scratch.editorItemFileId,
            worktreeId: editorItemWorktreeId,
            viewStateId: shownId,
            expiresAt: Date.now() + EDITOR_FOCUS_REQUEST_TTL_MS,
            token: takeNextEditorFocusRequestToken()
          }
        })
      }
      // Why: openWorkspaceEditorItem falls back to the file id when no tab exists; that is not a view.
      const view = (get().unifiedTabsByWorktree?.[editorItemWorktreeId] ?? []).find(
        (tab) => tab.id === shownId && tab.entityId === scratch.editorItemFileId
      )
      settled.result = view
        ? { fileId: scratch.editorItemFileId, viewStateId: view.id, groupId: view.groupId }
        : null
      onShown?.(settled.result)
    })
    // A tab main has yet to draw: the view the window proposed, shown once its frame is in.
    const proposedGroupId =
      pendingTabGroupId(editorItemViewStateId) ?? scratch.editorItemTargetGroupId
    const proposed = proposedGroupId
      ? {
          fileId: scratch.editorItemFileId,
          viewStateId: editorItemViewStateId,
          groupId: proposedGroupId
        }
      : null
    return { fileId: scratch.editorItemFileId, result: settled.ran ? settled.result : proposed }
  }

  return {
    openFile: (file, options) => open(file, options, null).fileId,
    openFileForLink: (file, options, intent, onShown) =>
      open(file, { ...options, focusEditor: true }, intent, (result) => {
        // Why: created and reused views must land identically; creating in another group leaves focus behind.
        if (result) {
          get().focusGroup?.(file.worktreeId, result.groupId)
        }
        onShown?.(result)
      }).result
  }
}
