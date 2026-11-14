import { editorPlacementIntent } from '../tabs/editor-placement-intent'
import { buildEditorActiveResult } from '../tabs/editor-open-target-group'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { joinPath } from '@/lib/path'
import type { OpenFile } from '../types/open-file'
import type { ConflictReviewState } from '../../../../../../shared/editor-tab-view-types'
import { toOpenConflictMetadata } from './git-status-reconciliation'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'
import { resolveEditorFileIdForOwner } from '../file-ids/editor-file-ids'
import { editorOpenOwner, qualifyEditorContentId } from './editor-open-owner'

export function createOpenConflictReview(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openConflictReviewFile' | 'openConflictReview'> {
  return {
    openConflictReviewFile: (reviewFileId, worktreeId, worktreePath, entry, language) => {
      const absolutePath = joinPath(worktreePath, entry.path)
      const reviewTab = Object.values(get().unifiedTabsByWorktree ?? {})
        .flat()
        .find((tab) => tab.entityId === reviewFileId && tab.contentType === 'conflict-review')
      const placementId = reviewTab?.worktreeId ?? worktreeId
      const intent = editorPlacementIntent(get, placementId)
      let openedConflictFile = true
      let conflictFileId = absolutePath
      set((s) => {
        const conflict = toOpenConflictMetadata(entry)
        const reviewFile = s.openFiles.find((file) => file.id === reviewFileId)
        const contentOwner = reviewFile
          ? {
              runtimeEnvironmentId: reviewFile.runtimeEnvironmentId,
              operationProvenance: reviewFile.operationProvenance,
              externalSshTargetId: reviewFile.externalSshTargetId
            }
          : editorOpenOwner(s, worktreeId)
        const { runtimeEnvironmentId } = contentOwner
        // Why: a server's file is open under its owned id; looking up the bare path would open a second copy.
        const fileId = resolveEditorFileIdForOwner(
          s,
          absolutePath,
          worktreeId,
          runtimeEnvironmentId,
          ['edit']
        )
        conflictFileId = fileId
        intent.register(fileId)
        const existing = s.openFiles.find((f) => f.id === fileId)
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

        const nextOpenFiles = existing
          ? s.openFiles.map((f) =>
              f.id === fileId
                ? {
                    ...f,
                    mode: 'edit' as const,
                    language,
                    relativePath: entry.path,
                    filePath: absolutePath,
                    conflict,
                    diffSource: undefined,
                    skippedConflicts: undefined,
                    conflictReview: undefined
                  }
                : f.id === reviewFileId && f.conflictReview
                  ? {
                      ...f,
                      conflictReview: {
                        ...f.conflictReview,
                        selectedFileId: fileId
                      }
                    }
                  : f
            )
          : [
              ...s.openFiles.map((f) =>
                f.id === reviewFileId && f.conflictReview
                  ? {
                      ...f,
                      conflictReview: {
                        ...f.conflictReview,
                        selectedFileId: fileId
                      }
                    }
                  : f
              ),
              {
                id: fileId,
                filePath: absolutePath,
                relativePath: entry.path,
                worktreeId,
                language,
                isDirty: false,
                mode: 'edit' as const,
                conflict,
                ...contentOwner
              }
            ]

        return {
          openFiles: nextOpenFiles,
          activeFileId: reviewFileId,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [placementId]: reviewFileId },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [placementId]: 'editor' },
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
      // Conflict files need backing editor tabs for save/close; restore review focus after opening them.
      intent.finish(() =>
        openWorkspaceEditorItem(
          get(),
          conflictFileId,
          placementId,
          entry.path,
          'editor',
          undefined,
          reviewTab?.groupId
        )
      )
      if (reviewTab) {
        get().activateTab?.(reviewTab.id)
      }
    },

    // Snapshot entries/time keeps conflict review stable across status polls.
    openConflictReview: (worktreeId, worktreePath, entries, source, options) => {
      const placementId = options?.placementWorkspaceId ?? worktreeId
      const intent = editorPlacementIntent(get, placementId)
      const contentOwner = editorOpenOwner(get(), worktreeId, options)
      const id = qualifyEditorContentId(
        `${worktreeId}::conflict-review`,
        contentOwner.runtimeEnvironmentId,
        contentOwner.operationProvenance?.generation.route.executionHostId ?? undefined
      )
      set((s) => {
        intent.register(id)
        const conflictReview: ConflictReviewState = {
          source,
          snapshotTimestamp: Date.now(),
          entries
        }
        const existing = s.openFiles.find((f) => f.id === id)

        if (existing) {
          return {
            openFiles: s.openFiles.map((f) =>
              f.id === id
                ? {
                    ...f,
                    mode: 'conflict-review' as const,
                    relativePath: 'Conflict Review',
                    filePath: worktreePath,
                    language: 'plaintext',
                    conflictReview,
                    conflict: undefined,
                    skippedConflicts: undefined
                  }
                : f
            ),
            ...buildEditorActiveResult(s, placementId, id)
          }
        }

        const newFile: OpenFile = {
          id,
          filePath: worktreePath,
          relativePath: 'Conflict Review',
          worktreeId,
          language: 'plaintext',
          isDirty: false,
          mode: 'conflict-review',
          conflictReview,
          ...contentOwner
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
          'Conflict Review',
          'conflict-review',
          false,
          options?.targetGroupId
        )
      )
    }
  }
}
