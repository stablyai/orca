import { editorPlacementIntent } from '../tabs/editor-placement-intent'
import {
  buildEditorActiveResult,
  resolveEditorOpenTargetGroupId
} from '../tabs/editor-open-target-group'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import type { OpenFile } from '../types/open-file'
import { editorOpenOwner, qualifyEditorContentId } from './editor-open-owner'
import { toBranchCompareSnapshot, toCommitCompareSnapshot } from './git-status-reconciliation'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'

export function createOpenCombinedDiff(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openAllDiffs' | 'openBranchAllDiffs' | 'openCommitAllDiffs'> {
  return {
    openAllDiffs: (worktreeId, worktreePath, alternate, areaFilter, entriesSnapshot, options) => {
      const contentOwner = editorOpenOwner(get(), worktreeId, options)
      const baseId = areaFilter
        ? `${worktreeId}::all-diffs::uncommitted::${areaFilter}`
        : `${worktreeId}::all-diffs::uncommitted`
      const id = qualifyEditorContentId(
        baseId,
        contentOwner.runtimeEnvironmentId,
        contentOwner.operationProvenance?.generation.route.executionHostId ?? undefined
      )
      const label = areaFilter
        ? ({ staged: 'Staged Changes', unstaged: 'Changes', untracked: 'Untracked Files' }[
            areaFilter
          ] ?? 'All Changes')
        : 'All Changes'
      const placementId = options?.placementWorkspaceId ?? worktreeId
      const intent = editorPlacementIntent(get, placementId)
      const groupId = resolveEditorOpenTargetGroupId(get(), placementId, options?.targetGroupId)
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
        intent.register(id)
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
                    ...contentOwner
                  }
                : f
            ),
            ...buildEditorActiveResult(s, placementId, id)
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
          ...contentOwner
        }
        return {
          openFiles: [...s.openFiles, newFile],
          ...buildEditorActiveResult(s, placementId, id)
        }
      })
      intent.finish(() =>
        openWorkspaceEditorItem(get(), id, placementId, label, 'diff', false, groupId)
      )
    },
    openBranchAllDiffs: (worktreeId, worktreePath, compare, alternate, options) => {
      const contentOwner = editorOpenOwner(get(), worktreeId, options)
      const branchCompare = toBranchCompareSnapshot(compare)
      const id = qualifyEditorContentId(
        `${worktreeId}::all-diffs::branch::${compare.baseRef}::${branchCompare.compareVersion}`,
        contentOwner.runtimeEnvironmentId,
        contentOwner.operationProvenance?.generation.route.executionHostId ?? undefined
      )
      const placementId = options?.placementWorkspaceId ?? worktreeId
      const intent = editorPlacementIntent(get, placementId)
      const groupId = resolveEditorOpenTargetGroupId(get(), placementId, options?.targetGroupId)
      set((s) => {
        const branchEntriesSnapshot = s.gitBranchChangesByWorktree[worktreeId] ?? []
        intent.register(id)
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
                    ...contentOwner
                  }
                : f
            ),
            ...buildEditorActiveResult(s, placementId, id)
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
          `Branch Changes (${compare.baseRef})`,
          'diff',
          false,
          groupId
        )
      )
    },

    openCommitAllDiffs: (worktreeId, worktreePath, compare, entries, subject, message, options) => {
      const contentOwner = editorOpenOwner(get(), worktreeId, options)
      const commitCompare = toCommitCompareSnapshot(compare, subject, message)
      const id = qualifyEditorContentId(
        `${worktreeId}::all-diffs::commit::${commitCompare.commitOid}`,
        contentOwner.runtimeEnvironmentId,
        contentOwner.operationProvenance?.generation.route.executionHostId ?? undefined
      )
      const label = subject
        ? `Commit ${commitCompare.compareRef}: ${subject}`
        : `Commit ${commitCompare.compareRef}`
      const placementId = options?.placementWorkspaceId ?? worktreeId
      const intent = editorPlacementIntent(get, placementId)
      const groupId = resolveEditorOpenTargetGroupId(get(), placementId, options?.targetGroupId)
      set((s) => {
        intent.register(id)
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
                    ...contentOwner
                  }
                : f
            ),
            ...buildEditorActiveResult(s, placementId, id)
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
          ...contentOwner
        }
        return {
          openFiles: [...s.openFiles, newFile],
          ...buildEditorActiveResult(s, placementId, id)
        }
      })
      intent.finish(() =>
        openWorkspaceEditorItem(get(), id, placementId, label, 'diff', false, groupId)
      )
    }
  }
}
