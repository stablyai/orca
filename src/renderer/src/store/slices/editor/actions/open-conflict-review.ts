import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { joinPath } from '@/lib/path'
import type { ConflictReviewState, OpenFile } from '../types/open-file'
import { toOpenConflictMetadata } from '../git/git-status-reconciliation'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'

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
      set((s) => {
        const conflict = toOpenConflictMetadata(entry)
        const existing = s.openFiles.find((f) => f.id === absolutePath)
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
              f.id === absolutePath
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
                        selectedFileId: absolutePath
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
                        selectedFileId: absolutePath
                      }
                    }
                  : f
              ),
              {
                id: absolutePath,
                filePath: absolutePath,
                relativePath: entry.path,
                worktreeId,
                language,
                isDirty: false,
                mode: 'edit' as const,
                conflict
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
      // Why: the conflict file needs a normal editor backing tab for save/close, but selecting from Conflict Review must keep the review tab visible; restore focus after.
      void openWorkspaceEditorItem(
        get(),
        absolutePath,
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

    // Why: renders from a stored snapshot (entries + timestamp), not live status, so the list stays stable across polls while reviewing.
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
