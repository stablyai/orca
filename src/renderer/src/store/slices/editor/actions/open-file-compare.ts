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

export function createOpenFileCompare(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openFileCompare'> {
  return {
    openFileCompare: (worktreeId, left, right, language, options) => {
      const isPreview = resolveEditorPreviewIntent(get(), options?.preview)
      let editorItemTargetGroupId = options?.targetGroupId
      let editorItemFileId = ''
      let tabRelativePath = left.relativePath
      set((s) => {
        const runtimeEnvironmentId = resolveDiffRuntimeEnvironmentId(
          s,
          worktreeId,
          options?.runtimeEnvironmentId
        )
        // Why: lexicographic order keeps A↔B and B↔A on one tab id.
        const [orderedLeft, orderedRight] =
          left.relativePath < right.relativePath ||
          (left.relativePath === right.relativePath && left.filePath <= right.filePath)
            ? [left, right]
            : [right, left]
        tabRelativePath = orderedLeft.relativePath
        const pairKey = `${orderedLeft.relativePath}::${orderedRight.relativePath}`
        const diffSource: DiffSource = 'file-compare'
        const id = buildDiffEditorFileId(worktreeId, diffSource, pairKey, runtimeEnvironmentId)
        editorItemFileId = id
        const targetGroupId =
          resolveEditorOpenTargetGroupId(s, worktreeId, options?.targetGroupId) ?? undefined
        editorItemTargetGroupId = targetGroupId
        const activeResult = buildEditorActiveResult(s, worktreeId, id)
        const existing = s.openFiles.find((f) => f.id === id)
        if (existing) {
          const reopenedDiff = withDiffContentReloadRequest({
            ...existing,
            mode: 'diff' as const,
            diffSource,
            filePath: orderedLeft.filePath,
            relativePath: orderedLeft.relativePath,
            compareTarget: {
              filePath: orderedRight.filePath,
              relativePath: orderedRight.relativePath
            },
            conflict: undefined,
            skippedConflicts: undefined,
            conflictReview: undefined,
            isPreview: isPreview ? existing.isPreview : false,
            runtimeEnvironmentId
          })
          return {
            openFiles: s.openFiles.map((f) => (f.id === id ? reopenedDiff : f)),
            ...activeResult
          }
        }
        const newFile: OpenFile = {
          id,
          filePath: orderedLeft.filePath,
          relativePath: orderedLeft.relativePath,
          worktreeId,
          language,
          isDirty: false,
          mode: 'diff',
          diffSource,
          compareTarget: {
            filePath: orderedRight.filePath,
            relativePath: orderedRight.relativePath
          },
          conflict: undefined,
          skippedConflicts: undefined,
          conflictReview: undefined,
          isPreview: isPreview || undefined,
          runtimeEnvironmentId
        }
        // Why: match openDiff — preview mode replaces a replaceable preview tab.
        if (isPreview) {
          const replaceablePreviewId = getReplaceablePreviewFileId(s, worktreeId, targetGroupId)
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
      void openWorkspaceEditorItem(
        get(),
        editorItemFileId,
        worktreeId,
        tabRelativePath,
        'diff',
        isPreview,
        editorItemTargetGroupId
      )
    }
  }
}
