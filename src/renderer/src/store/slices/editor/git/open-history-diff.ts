import { editorPlacementIntent } from '../tabs/editor-placement-intent'
import {
  buildEditorActiveResult,
  resolveEditorOpenTargetGroupId
} from '../tabs/editor-open-target-group'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { joinPath } from '@/lib/path'
import type { OpenFile } from '../types/open-file'
import { withDiffContentReloadRequest } from '../file-ids/editor-file-ids'
import { editorOpenOwner, qualifyEditorContentId } from './editor-open-owner'
import { toBranchCompareSnapshot, toCommitCompareSnapshot } from './git-status-reconciliation'
import { resolveEditorPreviewIntent } from '../tabs/editor-preview-tab-setting'
import {
  getReplaceablePreviewFileId,
  openWorkspaceEditorItem,
  removeEditorStateForReplacedPreview
} from '../tabs/workspace-editor-item'

export function createOpenHistoryDiff(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openBranchDiff' | 'openCommitDiff'> {
  return {
    openBranchDiff: (worktreeId, worktreePath, entry, compare, language, options) => {
      const contentOwner = editorOpenOwner(get(), worktreeId, options)
      const branchCompare = toBranchCompareSnapshot(compare)
      const id = qualifyEditorContentId(
        `${worktreeId}::diff::branch::${compare.baseRef}::${branchCompare.compareVersion}::${entry.path}`,
        contentOwner.runtimeEnvironmentId,
        contentOwner.operationProvenance?.generation.route.executionHostId ?? undefined
      )
      const placementId = options?.placementWorkspaceId ?? worktreeId
      const intent = editorPlacementIntent(get, placementId)
      const isPreview = resolveEditorPreviewIntent(get(), options?.preview)
      let editorItemTargetGroupId = options?.targetGroupId
      set((s) => {
        intent.register(id)
        const targetGroupId =
          resolveEditorOpenTargetGroupId(s, placementId, options?.targetGroupId) ?? undefined
        editorItemTargetGroupId = targetGroupId

        const existing = s.openFiles.find((f) => f.id === id)
        if (existing) {
          const updatedPreview = isPreview ? existing.isPreview : false
          const reopenedDiff = withDiffContentReloadRequest({
            ...existing,
            mode: 'diff' as const,
            diffSource: 'branch' as const,
            branchCompare,
            branchOldPath: entry.oldPath,
            conflict: undefined,
            skippedConflicts: undefined,
            conflictReview: undefined,
            isPreview: updatedPreview,
            ...contentOwner
          })
          return {
            openFiles: s.openFiles.map((f) => (f.id === id ? reopenedDiff : f)),
            ...buildEditorActiveResult(s, placementId, id)
          }
        }
        const newFile: OpenFile = {
          id,
          filePath: joinPath(worktreePath, entry.path),
          relativePath: entry.path,
          worktreeId,
          language,
          isDirty: false,
          mode: 'diff',
          diffSource: 'branch',
          branchCompare,
          branchOldPath: entry.oldPath,
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
              ...buildEditorActiveResult(s, placementId, id)
            }
          }
        }
        return {
          openFiles: [...s.openFiles, newFile],
          ...buildEditorActiveResult(s, placementId, id)
        }
      })
      intent.finish(() =>
        openWorkspaceEditorItem(
          get(),
          id,
          placementId,
          entry.path,
          'diff',
          isPreview,
          editorItemTargetGroupId
        )
      )
    },

    openCommitDiff: (worktreeId, worktreePath, entry, compare, language, options) => {
      const contentOwner = editorOpenOwner(get(), worktreeId, options)
      const commitCompare = toCommitCompareSnapshot(compare)
      const id = qualifyEditorContentId(
        `${worktreeId}::diff::commit::${commitCompare.compareVersion}::${entry.path}`,
        contentOwner.runtimeEnvironmentId,
        contentOwner.operationProvenance?.generation.route.executionHostId ?? undefined
      )
      const placementId = options?.placementWorkspaceId ?? worktreeId
      const intent = editorPlacementIntent(get, placementId)
      const isPreview = resolveEditorPreviewIntent(get(), options?.preview)
      let editorItemTargetGroupId = options?.targetGroupId
      set((s) => {
        intent.register(id)
        const targetGroupId =
          resolveEditorOpenTargetGroupId(s, placementId, options?.targetGroupId) ?? undefined
        editorItemTargetGroupId = targetGroupId

        const existing = s.openFiles.find((f) => f.id === id)
        if (existing) {
          const updatedPreview = isPreview ? existing.isPreview : false
          const reopenedDiff = withDiffContentReloadRequest({
            ...existing,
            mode: 'diff' as const,
            diffSource: 'commit' as const,
            commitCompare,
            branchOldPath: entry.oldPath,
            conflict: undefined,
            skippedConflicts: undefined,
            conflictReview: undefined,
            isPreview: updatedPreview,
            ...contentOwner
          })
          return {
            openFiles: s.openFiles.map((f) => (f.id === id ? reopenedDiff : f)),
            ...buildEditorActiveResult(s, placementId, id)
          }
        }
        const newFile: OpenFile = {
          id,
          filePath: joinPath(worktreePath, entry.path),
          relativePath: entry.path,
          worktreeId,
          language,
          isDirty: false,
          mode: 'diff',
          diffSource: 'commit',
          commitCompare,
          branchOldPath: entry.oldPath,
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
              ...buildEditorActiveResult(s, placementId, id)
            }
          }
        }
        return {
          openFiles: [...s.openFiles, newFile],
          ...buildEditorActiveResult(s, placementId, id)
        }
      })
      intent.finish(() =>
        openWorkspaceEditorItem(
          get(),
          id,
          placementId,
          entry.path,
          'diff',
          isPreview,
          editorItemTargetGroupId
        )
      )
    }
  }
}
