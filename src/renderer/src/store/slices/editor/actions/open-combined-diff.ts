import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import type { OpenFile } from '../types/open-file'
import { resolveDiffRuntimeEnvironmentId } from '../git/diff-runtime-owner'
import { toBranchCompareSnapshot, toCommitCompareSnapshot } from '../git/git-status-reconciliation'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'

export function createOpenCombinedDiff(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openAllDiffs' | 'openBranchAllDiffs' | 'openCommitAllDiffs'> {
  return {
    openAllDiffs: (worktreeId, worktreePath, alternate, areaFilter, entriesSnapshot) => {
      const id = areaFilter
        ? `${worktreeId}::all-diffs::uncommitted::${areaFilter}`
        : `${worktreeId}::all-diffs::uncommitted`
      const label = areaFilter
        ? ({ staged: 'Staged Changes', unstaged: 'Changes', untracked: 'Untracked Files' }[
            areaFilter
          ] ?? 'All Changes')
        : 'All Changes'
      set((s) => {
        const branchSummary = s.gitBranchCompareSummaryByWorktree[worktreeId]
        const branchCompare =
          !areaFilter &&
          branchSummary?.status === 'ready' &&
          branchSummary.baseOid &&
          branchSummary.headOid &&
          branchSummary.mergeBase
            ? toBranchCompareSnapshot(branchSummary)
            : undefined
        const branchEntriesSnapshot = branchCompare
          ? (s.gitBranchChangesByWorktree[worktreeId] ?? [])
          : undefined
        const relevantEntries =
          entriesSnapshot ??
          (s.gitStatusByWorktree[worktreeId] ?? []).filter((entry) => {
            return areaFilter === undefined || entry.area === areaFilter
          })
        const skippedConflicts = relevantEntries
          .filter((entry) => entry.conflictStatus === 'unresolved' && entry.conflictKind)
          .map((entry) => ({ path: entry.path, conflictKind: entry.conflictKind! }))
        // Why: snapshot entries at open time so a later commit can't yank them and force a rebuild that loses loaded content + scroll position.
        const uncommittedEntriesSnapshot = relevantEntries
        const id = areaFilter
          ? `${worktreeId}::all-diffs::uncommitted::${areaFilter}`
          : `${worktreeId}::all-diffs::uncommitted`
        const label = areaFilter
          ? ({ staged: 'Staged Changes', unstaged: 'Changes', untracked: 'Untracked Files' }[
              areaFilter
            ] ?? 'All Changes')
          : 'All Changes'
        const runtimeEnvironmentId = resolveDiffRuntimeEnvironmentId(s, worktreeId, undefined)
        const existing = s.openFiles.find((f) => f.id === id)
        if (existing) {
          return {
            openFiles: s.openFiles.map((f) =>
              f.id === id
                ? {
                    ...f,
                    diffSource: branchCompare ? 'combined-all' : 'combined-uncommitted',
                    branchCompare,
                    branchEntriesSnapshot,
                    uncommittedEntriesSnapshot,
                    combinedAlternate: alternate,
                    combinedAreaFilter: areaFilter,
                    skippedConflicts,
                    conflictReview: undefined,
                    conflict: undefined,
                    runtimeEnvironmentId
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
          relativePath: label,
          worktreeId,
          language: 'plaintext',
          isDirty: false,
          mode: 'diff',
          diffSource: branchCompare ? 'combined-all' : 'combined-uncommitted',
          branchCompare,
          branchEntriesSnapshot,
          uncommittedEntriesSnapshot,
          combinedAlternate: alternate,
          combinedAreaFilter: areaFilter,
          skippedConflicts,
          conflictReview: undefined,
          conflict: undefined,
          runtimeEnvironmentId
        }
        return {
          openFiles: [...s.openFiles, newFile],
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      })
      void openWorkspaceEditorItem(get(), id, worktreeId, label, 'diff')
    },
    openBranchAllDiffs: (worktreeId, worktreePath, compare, alternate) => {
      const branchCompare = toBranchCompareSnapshot(compare)
      const id = `${worktreeId}::all-diffs::branch::${compare.baseRef}::${branchCompare.compareVersion}`
      set((s) => {
        const runtimeEnvironmentId = resolveDiffRuntimeEnvironmentId(s, worktreeId, undefined)
        const branchEntriesSnapshot = s.gitBranchChangesByWorktree[worktreeId] ?? []
        const existing = s.openFiles.find((f) => f.id === id)
        if (existing) {
          return {
            openFiles: s.openFiles.map((f) =>
              f.id === id
                ? {
                    ...f,
                    branchCompare,
                    branchEntriesSnapshot,
                    combinedAlternate: alternate,
                    conflict: undefined,
                    skippedConflicts: undefined,
                    conflictReview: undefined,
                    runtimeEnvironmentId
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
          relativePath: `Branch Changes (${compare.baseRef})`,
          worktreeId,
          language: 'plaintext',
          isDirty: false,
          mode: 'diff',
          diffSource: 'combined-branch',
          branchCompare,
          branchEntriesSnapshot,
          combinedAlternate: alternate,
          conflict: undefined,
          skippedConflicts: undefined,
          conflictReview: undefined,
          runtimeEnvironmentId
        }
        return {
          openFiles: [...s.openFiles, newFile],
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      })
      void openWorkspaceEditorItem(
        get(),
        id,
        worktreeId,
        `Branch Changes (${compare.baseRef})`,
        'diff'
      )
    },

    openCommitAllDiffs: (worktreeId, worktreePath, compare, entries, subject, message) => {
      const commitCompare = toCommitCompareSnapshot(compare, subject, message)
      const id = `${worktreeId}::all-diffs::commit::${commitCompare.commitOid}`
      const label = subject
        ? `Commit ${commitCompare.compareRef}: ${subject}`
        : `Commit ${commitCompare.compareRef}`
      set((s) => {
        const runtimeEnvironmentId = resolveDiffRuntimeEnvironmentId(s, worktreeId, undefined)
        const existing = s.openFiles.find((f) => f.id === id)
        if (existing) {
          return {
            openFiles: s.openFiles.map((f) =>
              f.id === id
                ? {
                    ...f,
                    relativePath: label,
                    commitCompare,
                    commitEntriesSnapshot: entries,
                    conflict: undefined,
                    skippedConflicts: undefined,
                    conflictReview: undefined,
                    runtimeEnvironmentId
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
          relativePath: label,
          worktreeId,
          language: 'plaintext',
          isDirty: false,
          mode: 'diff',
          diffSource: 'combined-commit',
          commitCompare,
          commitEntriesSnapshot: entries,
          conflict: undefined,
          skippedConflicts: undefined,
          conflictReview: undefined,
          runtimeEnvironmentId
        }
        return {
          openFiles: [...s.openFiles, newFile],
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      })
      void openWorkspaceEditorItem(get(), id, worktreeId, label, 'diff')
    }
  }
}
