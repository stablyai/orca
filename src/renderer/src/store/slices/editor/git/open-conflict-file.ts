import { editorPlacementIntent } from '../tabs/editor-placement-intent'
import {
  buildEditorActiveResult,
  resolveEditorOpenTargetGroupId
} from '../tabs/editor-open-target-group'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { resolveEditorFileIdForOwner } from '../file-ids/editor-file-ids'
import { editorOpenOwner } from './editor-open-owner'
import { joinPath } from '@/lib/path'
import type { OpenFile } from '../types/open-file'
import { toOpenConflictMetadata } from './git-status-reconciliation'
import { resolveEditorPreviewIntent } from '../tabs/editor-preview-tab-setting'
import {
  getReplaceablePreviewFileId,
  openWorkspaceEditorItem,
  removeEditorStateForReplacedPreview
} from '../tabs/workspace-editor-item'

export function createOpenConflictFile(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openConflictFile'> {
  return {
    openConflictFile: (worktreeId, worktreePath, entry, language, options) => {
      const absolutePath = joinPath(worktreePath, entry.path)
      const placementId = options?.placementWorkspaceId ?? worktreeId
      const intent = editorPlacementIntent(get, placementId)
      const isPreview = resolveEditorPreviewIntent(get(), options?.preview)
      let editorItemTargetGroupId = options?.targetGroupId
      let openedConflictFile = true
      let conflictFileId = absolutePath
      set((s) => {
        const contentOwner = editorOpenOwner(s, worktreeId, options)
        const { runtimeEnvironmentId } = contentOwner
        const id = resolveEditorFileIdForOwner(s, absolutePath, worktreeId, runtimeEnvironmentId, [
          'edit'
        ])
        conflictFileId = id
        intent.register(id)
        const conflict = toOpenConflictMetadata(entry)
        const targetGroupId =
          resolveEditorOpenTargetGroupId(s, placementId, options?.targetGroupId) ?? undefined
        editorItemTargetGroupId = targetGroupId
        const existing = s.openFiles.find((f) => f.id === id)
        const nextTracked =
          entry.conflictStatus === 'unresolved' && entry.conflictKind
            ? {
                ...s.trackedConflictPathsByWorktree[worktreeId],
                [entry.path]: entry.conflictKind
              }
            : s.trackedConflictPathsByWorktree[worktreeId]

        if (!conflict) {
          openedConflictFile = false
          return s
        }

        if (existing) {
          const updatedPreview = isPreview ? existing.isPreview : false
          return {
            openFiles: s.openFiles.map((f) =>
              f.id === id
                ? {
                    ...f,
                    mode: 'edit' as const,
                    language,
                    relativePath: entry.path,
                    filePath: absolutePath,
                    conflict,
                    diffSource: undefined,
                    skippedConflicts: undefined,
                    conflictReview: undefined,
                    ...contentOwner,
                    isPreview: updatedPreview
                  }
                : f
            ),
            ...buildEditorActiveResult(s, placementId, id),
            trackedConflictPathsByWorktree:
              nextTracked === s.trackedConflictPathsByWorktree[worktreeId]
                ? s.trackedConflictPathsByWorktree
                : { ...s.trackedConflictPathsByWorktree, [worktreeId]: nextTracked }
          }
        }

        const newFile: OpenFile = {
          id,
          filePath: absolutePath,
          relativePath: entry.path,
          worktreeId,
          ...contentOwner,
          language,
          isDirty: false,
          mode: 'edit',
          conflict,
          isPreview: isPreview || undefined
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
              ...buildEditorActiveResult(s, placementId, id),
              trackedConflictPathsByWorktree:
                nextTracked === s.trackedConflictPathsByWorktree[worktreeId]
                  ? s.trackedConflictPathsByWorktree
                  : { ...s.trackedConflictPathsByWorktree, [worktreeId]: nextTracked }
            }
          }
        }

        return {
          openFiles: [...s.openFiles, newFile],
          ...buildEditorActiveResult(s, placementId, id),
          trackedConflictPathsByWorktree:
            nextTracked === s.trackedConflictPathsByWorktree[worktreeId]
              ? s.trackedConflictPathsByWorktree
              : { ...s.trackedConflictPathsByWorktree, [worktreeId]: nextTracked }
        }
      })
      // Why: no conflict metadata means no OpenFile was added, so a workspace tab would point at nothing.
      if (!openedConflictFile) {
        intent.finish(null)
        return
      }
      intent.finish(() =>
        openWorkspaceEditorItem(
          get(),
          conflictFileId,
          placementId,
          entry.path,
          'editor',
          isPreview,
          editorItemTargetGroupId
        )
      )
    }
  }
}
