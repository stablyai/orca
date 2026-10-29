import { editSessionSource } from '@/store/session-source-edits'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { joinPath } from '@/lib/path'
import type { OpenFile } from '../types/open-file'
import { toOpenConflictMetadata } from '../git/git-status-reconciliation'
import { resolveEditorOpenTargetGroupId } from '../tabs/editor-open-target-group'
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
      const isPreview = resolveEditorPreviewIntent(get(), options?.preview)
      let editorItemTargetGroupId = options?.targetGroupId
      let openedConflictFile = true
      set((s) => {
        const sourceEdit = editSessionSource(s)

        const id = absolutePath
        const conflict = toOpenConflictMetadata(entry)
        const targetGroupId =
          resolveEditorOpenTargetGroupId(s, worktreeId, options?.targetGroupId) ?? undefined
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
          return undefined
        }

        if (existing) {
          const updatedPreview = isPreview ? existing.isPreview : false
          sourceEdit.sequence('openFiles').map((f) =>
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
                  isPreview: updatedPreview
                }
              : f
          )
          sourceEdit.set('activeFileIdByWorktree', worktreeId, id)
          sourceEdit.set('activeTabTypeByWorktree', worktreeId, 'editor')
          return sourceEdit.finish({
            activeFileId: id,
            activeTabType: 'editor',
            trackedConflictPathsByWorktree:
              nextTracked === s.trackedConflictPathsByWorktree[worktreeId]
                ? s.trackedConflictPathsByWorktree
                : { ...s.trackedConflictPathsByWorktree, [worktreeId]: nextTracked }
          })
        }

        const newFile: OpenFile = {
          id,
          filePath: absolutePath,
          relativePath: entry.path,
          worktreeId,
          language,
          isDirty: false,
          mode: 'edit',
          conflict,
          isPreview: isPreview || undefined
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
              .set('activeFileIdByWorktree', worktreeId, id)
              .set('activeTabTypeByWorktree', worktreeId, 'editor')
              .finish({
                ...removeEditorStateForReplacedPreview(
                  sourceEdit,
                  s.openFiles[replaceablePreviewIndex],
                  id
                ),
                activeFileId: id,
                activeTabType: 'editor',
                trackedConflictPathsByWorktree:
                  nextTracked === s.trackedConflictPathsByWorktree[worktreeId]
                    ? s.trackedConflictPathsByWorktree
                    : { ...s.trackedConflictPathsByWorktree, [worktreeId]: nextTracked }
              })
          }
        }

        sourceEdit.sequence('openFiles').append(newFile)
        sourceEdit.set('activeFileIdByWorktree', worktreeId, id)
        sourceEdit.set('activeTabTypeByWorktree', worktreeId, 'editor')
        return sourceEdit.finish({
          activeFileId: id,
          activeTabType: 'editor',
          trackedConflictPathsByWorktree:
            nextTracked === s.trackedConflictPathsByWorktree[worktreeId]
              ? s.trackedConflictPathsByWorktree
              : { ...s.trackedConflictPathsByWorktree, [worktreeId]: nextTracked }
        })
      })
      // Why: no conflict metadata means no OpenFile was added, so a workspace tab would point at nothing.
      if (!openedConflictFile) {
        return
      }
      openWorkspaceEditorItem(
        get(),
        absolutePath,
        worktreeId,
        entry.path,
        'editor',
        isPreview,
        editorItemTargetGroupId
      )
    }
  }
}
