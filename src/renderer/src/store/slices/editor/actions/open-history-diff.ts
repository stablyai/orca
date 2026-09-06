import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { joinPath } from '@/lib/path'
import type { OpenFile } from '../types/open-file'
import { withDiffContentReloadRequest } from '../file-ids/editor-file-ids'
import { resolveDiffRuntimeEnvironmentId } from '../git/diff-runtime-owner'
import { toBranchCompareSnapshot, toCommitCompareSnapshot } from '../git/git-status-reconciliation'
import { resolveEditorOpenTargetGroupId } from '../tabs/editor-open-target-group'
import {
  resolveReplaceablePreviewSlot,
  openWorkspaceEditorItem,
  removeEditorStateForReplacedPreview
} from '../tabs/workspace-editor-item'

export function createOpenHistoryDiff(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openBranchDiff' | 'openCommitDiff'> {
  return {
    openBranchDiff: (worktreeId, worktreePath, entry, compare, language, options) => {
      const branchCompare = toBranchCompareSnapshot(compare)
      const id = `${worktreeId}::diff::branch::${compare.baseRef}::${branchCompare.compareVersion}::${entry.path}`
      const isPreview = options?.preview ?? false
      let editorItemTargetGroupId = options?.targetGroupId
      set((s) => {
        const targetGroupId =
          resolveEditorOpenTargetGroupId(s, worktreeId, options?.targetGroupId) ?? undefined
        editorItemTargetGroupId = targetGroupId
        const runtimeEnvironmentId = resolveDiffRuntimeEnvironmentId(
          s,
          worktreeId,
          options?.runtimeEnvironmentId
        )
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
            runtimeEnvironmentId
          })
          return {
            openFiles: s.openFiles.map((f) => (f.id === id ? reopenedDiff : f)),
            activeFileId: id,
            activeTabType: 'editor',
            activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
            activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
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
          runtimeEnvironmentId
        }
        if (isPreview) {
          const slot = resolveReplaceablePreviewSlot(s, worktreeId, options?.targetGroupId)
          if (slot) {
            editorItemTargetGroupId = slot.retargetGroupId ?? editorItemTargetGroupId
            return {
              openFiles: s.openFiles.map((file, index) => (index === slot.index ? newFile : file)),
              ...removeEditorStateForReplacedPreview(s, s.openFiles[slot.index], id),
              activeFileId: id,
              activeTabType: 'editor',
              activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
              activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
            }
          }
        }
        return {
          openFiles: [...s.openFiles, newFile],
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      })
      void openWorkspaceEditorItem(get(), id, worktreeId, entry.path, 'diff', {
        isPreview,
        targetGroupId: editorItemTargetGroupId,
        pinnedGroupId: options?.targetGroupId
      })
    },

    openCommitDiff: (worktreeId, worktreePath, entry, compare, language, options) => {
      const commitCompare = toCommitCompareSnapshot(compare)
      const id = `${worktreeId}::diff::commit::${commitCompare.compareVersion}::${entry.path}`
      const isPreview = options?.preview ?? false
      let editorItemTargetGroupId = options?.targetGroupId
      set((s) => {
        const targetGroupId =
          resolveEditorOpenTargetGroupId(s, worktreeId, options?.targetGroupId) ?? undefined
        editorItemTargetGroupId = targetGroupId
        const runtimeEnvironmentId = resolveDiffRuntimeEnvironmentId(
          s,
          worktreeId,
          options?.runtimeEnvironmentId
        )
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
            runtimeEnvironmentId
          })
          return {
            openFiles: s.openFiles.map((f) => (f.id === id ? reopenedDiff : f)),
            activeFileId: id,
            activeTabType: 'editor',
            activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
            activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
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
          runtimeEnvironmentId
        }
        if (isPreview) {
          const slot = resolveReplaceablePreviewSlot(s, worktreeId, options?.targetGroupId)
          if (slot) {
            editorItemTargetGroupId = slot.retargetGroupId ?? editorItemTargetGroupId
            return {
              openFiles: s.openFiles.map((file, index) => (index === slot.index ? newFile : file)),
              ...removeEditorStateForReplacedPreview(s, s.openFiles[slot.index], id),
              activeFileId: id,
              activeTabType: 'editor',
              activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
              activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
            }
          }
        }
        return {
          openFiles: [...s.openFiles, newFile],
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      })
      void openWorkspaceEditorItem(get(), id, worktreeId, entry.path, 'diff', {
        isPreview,
        targetGroupId: editorItemTargetGroupId,
        pinnedGroupId: options?.targetGroupId
      })
    }
  }
}
