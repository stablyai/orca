import { editorPlacementIntent } from '../tabs/editor-placement-intent'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import type { OpenFile } from '../types/open-file'
import type { DiffSource } from '../../../../../../shared/editor-tab-view-types'
import { buildDiffEditorFileId, withDiffContentReloadRequest } from '../file-ids/editor-file-ids'
import { editorOpenOwner, qualifyEditorContentId } from './editor-open-owner'
import {
  buildEditorActiveResult,
  resolveEditorOpenTargetGroupId
} from '../tabs/editor-open-target-group'
import { resolveEditorPreviewIntent } from '../tabs/editor-preview-tab-setting'
import {
  getReplaceablePreviewFileId,
  openWorkspaceEditorItem,
  removeEditorStateForReplacedPreview
} from '../tabs/workspace-editor-item'

export function createOpenUnstagedDiff(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openDiff'> {
  return {
    openDiff: (worktreeId, filePath, relativePath, language, staged, options) => {
      const placementId = options?.placementWorkspaceId ?? worktreeId
      const intent = editorPlacementIntent(get, placementId)
      const isPreview = resolveEditorPreviewIntent(get(), options?.preview)
      const selection = options?.selection
      let editorItemTargetGroupId = options?.targetGroupId
      let editorItemFileId = ''
      set((s) => {
        const contentOwner = editorOpenOwner(s, worktreeId, options)
        const { runtimeEnvironmentId } = contentOwner
        const diffSource: DiffSource = staged ? 'staged' : 'unstaged'
        const id = qualifyEditorContentId(
          buildDiffEditorFileId(worktreeId, diffSource, relativePath, runtimeEnvironmentId),
          undefined,
          contentOwner.operationProvenance?.generation.route.executionHostId ?? undefined
        )
        intent.register(id)
        editorItemFileId = id
        const targetGroupId =
          resolveEditorOpenTargetGroupId(s, placementId, options?.targetGroupId) ?? undefined
        editorItemTargetGroupId = targetGroupId
        const activeResult = selection === 'none' ? {} : buildEditorActiveResult(s, placementId, id)
        const existing = s.openFiles.find((f) => f.id === id)
        if (existing) {
          const updatedPreview = isPreview ? existing.isPreview : false
          const reopenedDiff = withDiffContentReloadRequest({
            ...existing,
            mode: 'diff' as const,
            diffSource,
            branchOldPath: staged ? options?.oldPath : undefined,
            conflict: undefined,
            skippedConflicts: undefined,
            conflictReview: undefined,
            isPreview: updatedPreview,
            ...contentOwner
          })
          return {
            openFiles: s.openFiles.map((f) => (f.id === id ? reopenedDiff : f)),
            ...activeResult
          }
        }
        const newFile: OpenFile = {
          id,
          filePath,
          relativePath,
          worktreeId,
          language,
          isDirty: false,
          mode: 'diff',
          diffSource,
          branchOldPath: staged ? options?.oldPath : undefined,
          conflict: undefined,
          skippedConflicts: undefined,
          conflictReview: undefined,
          isPreview: isPreview || undefined,
          ...contentOwner
        }
        if (isPreview) {
          const replaceablePreviewId = getReplaceablePreviewFileId(s, placementId, targetGroupId)
          const replaceablePreviewIndex = s.openFiles.findIndex(
            (file) => file.id === replaceablePreviewId
          )
          if (replaceablePreviewIndex !== -1) {
            return {
              openFiles: s.openFiles.map((file, index) =>
                index === replaceablePreviewIndex ? newFile : file
              ),
              ...removeEditorStateForReplacedPreview(s, s.openFiles[replaceablePreviewIndex], id),
              ...activeResult
            }
          }
        }
        return {
          openFiles: [...s.openFiles, newFile],
          ...activeResult
        }
      })
      intent.finish(() =>
        openWorkspaceEditorItem(
          get(),
          editorItemFileId,
          placementId,
          relativePath,
          'diff',
          isPreview,
          editorItemTargetGroupId,
          selection
        )
      )
    }
  }
}
