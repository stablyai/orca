import { editSessionSource } from '@/store/session-source-edits'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import type { OpenFile } from '../types/open-file'
import type { DiffSource } from '../../../../../../shared/editor-tab-view-types'
import { buildDiffEditorFileId, withDiffContentReloadRequest } from '../file-ids/editor-file-ids'
import { resolveDiffRuntimeEnvironmentId } from '../git/diff-runtime-owner'
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
      const isPreview = resolveEditorPreviewIntent(get(), options?.preview)
      const selection = options?.selection
      let editorItemTargetGroupId = options?.targetGroupId
      let editorItemFileId = ''
      set((s) => {
        const sourceEdit = editSessionSource(s)
        const runtimeEnvironmentId = resolveDiffRuntimeEnvironmentId(
          s,
          worktreeId,
          options?.runtimeEnvironmentId
        )
        const diffSource: DiffSource = staged ? 'staged' : 'unstaged'
        const id = buildDiffEditorFileId(worktreeId, diffSource, relativePath, runtimeEnvironmentId)
        editorItemFileId = id
        const targetGroupId =
          resolveEditorOpenTargetGroupId(s, worktreeId, options?.targetGroupId) ?? undefined
        editorItemTargetGroupId = targetGroupId
        const activeResult =
          selection === 'none' ? {} : buildEditorActiveResult(sourceEdit, worktreeId, id)
        const existing = s.openFiles.find((f) => f.id === id)
        if (existing) {
          const updatedPreview = isPreview ? existing.isPreview : false
          const reopenedDiff = withDiffContentReloadRequest({
            ...existing,
            mode: 'diff' as const,
            diffSource,
            conflict: undefined,
            skippedConflicts: undefined,
            conflictReview: undefined,
            isPreview: updatedPreview,
            runtimeEnvironmentId
          })
          return sourceEdit
            .sequence('openFiles')
            .map((f) => (f.id === id ? reopenedDiff : f))
            .finish(activeResult)
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
          conflict: undefined,
          skippedConflicts: undefined,
          conflictReview: undefined,
          isPreview: isPreview || undefined,
          runtimeEnvironmentId
        }
        if (isPreview) {
          const replaceablePreviewId = getReplaceablePreviewFileId(s, worktreeId, targetGroupId)
          const replaceablePreviewIndex = s.openFiles.findIndex(
            (file) => file.id === replaceablePreviewId
          )
          if (replaceablePreviewIndex !== -1) {
            return sourceEdit
              .sequence('openFiles')
              .map((file, index) => (index === replaceablePreviewIndex ? newFile : file))
              .finish({
                ...removeEditorStateForReplacedPreview(
                  sourceEdit,
                  s.openFiles[replaceablePreviewIndex],
                  id
                ),
                ...activeResult
              })
          }
        }
        return sourceEdit.sequence('openFiles').append(newFile).finish(activeResult)
      })
      void openWorkspaceEditorItem(
        get(),
        editorItemFileId,
        worktreeId,
        relativePath,
        'diff',
        isPreview,
        editorItemTargetGroupId,
        selection
      )
    }
  }
}
