import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { joinPath } from '@/lib/path'
import type { OpenFile } from '../types/open-file'
import type { ConflictReviewState } from '../../../../../../shared/editor-tab-view-types'
import { toOpenConflictMetadata } from '../git/git-status-reconciliation'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'
import { resolveEditorFileIdForOwner } from '../file-ids/editor-file-ids'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import type { AppState } from '../../../types'

/** The runtime owner `openFile` gives a file opened in this workspace; null when it cannot tell. */
function conflictFileRuntimeOwner(s: AppState, worktreeId: string): string | null {
  try {
    return captureEditorFileOperationProvenance(s, worktreeId, undefined, false).generation.route
      .runtimeEnvironmentId
  } catch {
    return null
  }
}

export function createOpenConflictReview(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openConflictReviewFile' | 'openConflictReview'> {
  return {
    openConflictReviewFile: (reviewFileId, worktreeId, worktreePath, entry, language) => {
      const absolutePath = joinPath(worktreePath, entry.path)
      const reviewTab = (get().unifiedTabsByWorktree?.[worktreeId] ?? []).find(
        (tab) => tab.entityId === reviewFileId && tab.contentType === 'conflict-review'
      )
      let openedConflictFile = true
      let conflictFileId = absolutePath
      set((s) => {
        const conflict = toOpenConflictMetadata(entry)
        const runtimeEnvironmentId = conflictFileRuntimeOwner(s, worktreeId)
        // Why: a server's file is open under its owned id; looking up the bare path would open a second copy.
        const fileId = resolveEditorFileIdForOwner(
          s,
          absolutePath,
          worktreeId,
          runtimeEnvironmentId,
          ['edit']
        )
        conflictFileId = fileId
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
                ...(runtimeEnvironmentId ? { runtimeEnvironmentId } : {})
              }
            ]

        return {
          openFiles: nextOpenFiles,
          activeFileId: reviewFileId,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: reviewFileId },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' },
          trackedConflictPathsByWorktree:
            nextTracked === s.trackedConflictPathsByWorktree[worktreeId]
              ? s.trackedConflictPathsByWorktree
              : { ...s.trackedConflictPathsByWorktree, [worktreeId]: nextTracked }
        }
      })

      // Why: no conflict metadata means no OpenFile was added, so a workspace tab would point at nothing.
      if (!openedConflictFile) {
        return
      }
      // Conflict files need backing editor tabs for save/close; restore review focus after opening them.
      void openWorkspaceEditorItem(
        get(),
        conflictFileId,
        worktreeId,
        entry.path,
        'editor',
        undefined,
        reviewTab?.groupId
      )
      if (reviewTab) {
        get().activateTab?.(reviewTab.id)
      }
    },

    // Snapshot entries/time keeps conflict review stable across status polls.
    openConflictReview: (worktreeId, worktreePath, entries, source) => {
      const id = `${worktreeId}::conflict-review`
      set((s) => {
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
            activeFileId: id,
            activeTabType: 'editor',
            activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
            activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
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
          conflictReview
        }

        return {
          openFiles: [...s.openFiles, newFile],
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      })
      void openWorkspaceEditorItem(get(), id, worktreeId, 'Conflict Review', 'conflict-review')
    }
  }
}
