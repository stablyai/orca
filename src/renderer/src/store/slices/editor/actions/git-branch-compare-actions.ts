import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import {
  branchCompareMatchesStatusHead,
  createLoadingBranchCompareSummary,
  getKnownGitHead
} from '../git/branch-compare-state'

export function createGitBranchCompareActions(
  set: EditorSet,
  _get: EditorGet
): Pick<
  EditorSlice,
  | 'gitBranchChangesByWorktree'
  | 'gitBranchCompareSummaryByWorktree'
  | 'gitBranchCompareRequestKeyByWorktree'
  | 'gitBranchCompareRequestStatusHeadByWorktree'
  | 'beginGitBranchCompareRequest'
  | 'setGitBranchCompareResult'
  | 'clearGitBranchCompare'
> {
  return {
    gitBranchChangesByWorktree: {},
    gitBranchCompareSummaryByWorktree: {},
    gitBranchCompareRequestKeyByWorktree: {},
    gitBranchCompareRequestStatusHeadByWorktree: {},
    beginGitBranchCompareRequest: (worktreeId, requestKey, baseRef, options) =>
      set((s) => ({
        gitBranchCompareRequestKeyByWorktree: {
          ...s.gitBranchCompareRequestKeyByWorktree,
          [worktreeId]: requestKey
        },
        gitBranchCompareRequestStatusHeadByWorktree: {
          ...s.gitBranchCompareRequestStatusHeadByWorktree,
          [worktreeId]: getKnownGitHead(s.gitStatusHeadByWorktree[worktreeId]) ?? null
        },
        ...(options?.preserveExistingSummary
          ? {}
          : {
              gitBranchCompareSummaryByWorktree: {
                ...s.gitBranchCompareSummaryByWorktree,
                [worktreeId]: createLoadingBranchCompareSummary(baseRef)
              }
            })
      })),
    setGitBranchCompareResult: (worktreeId, requestKey, result) =>
      set((s) => {
        if (s.gitBranchCompareRequestKeyByWorktree[worktreeId] !== requestKey) {
          return s
        }
        const statusHead = getKnownGitHead(s.gitStatusHeadByWorktree[worktreeId])
        const requestStatusHead = s.gitBranchCompareRequestStatusHeadByWorktree[worktreeId]
        // Why: never let a compare result computed before a status change overwrite a newer status snapshot.
        if (
          result.summary.status !== 'loading' &&
          statusHead !== undefined &&
          requestStatusHead !== statusHead &&
          !branchCompareMatchesStatusHead(result.summary, statusHead)
        ) {
          return s
        }
        const prevEntries = s.gitBranchChangesByWorktree[worktreeId]
        const prevSummary = s.gitBranchCompareSummaryByWorktree[worktreeId]
        const entriesUnchanged =
          prevEntries &&
          prevEntries.length === result.entries.length &&
          prevEntries.every(
            (e, i) =>
              e.path === result.entries[i].path &&
              e.status === result.entries[i].status &&
              e.oldPath === result.entries[i].oldPath
          )
        const summaryUnchanged =
          prevSummary &&
          prevSummary.status === result.summary.status &&
          prevSummary.baseOid === result.summary.baseOid &&
          prevSummary.headOid === result.summary.headOid &&
          prevSummary.changedFiles === result.summary.changedFiles
        if (entriesUnchanged && summaryUnchanged) {
          return s
        }
        return {
          gitBranchChangesByWorktree: entriesUnchanged
            ? s.gitBranchChangesByWorktree
            : { ...s.gitBranchChangesByWorktree, [worktreeId]: result.entries },
          gitBranchCompareSummaryByWorktree: summaryUnchanged
            ? s.gitBranchCompareSummaryByWorktree
            : { ...s.gitBranchCompareSummaryByWorktree, [worktreeId]: result.summary }
        }
      }),
    // Why: when the compare base resolves to "no base", drop any stale summary so the committed-changes section and "vs" row disappear instead of lingering.
    clearGitBranchCompare: (worktreeId) =>
      set((s) => {
        if (
          s.gitBranchCompareSummaryByWorktree[worktreeId] === undefined &&
          s.gitBranchChangesByWorktree[worktreeId] === undefined &&
          s.gitBranchCompareRequestKeyByWorktree[worktreeId] === undefined &&
          s.gitBranchCompareRequestStatusHeadByWorktree[worktreeId] === undefined
        ) {
          return s
        }
        const nextSummary = { ...s.gitBranchCompareSummaryByWorktree }
        const nextChanges = { ...s.gitBranchChangesByWorktree }
        const nextRequestKey = { ...s.gitBranchCompareRequestKeyByWorktree }
        const nextRequestHead = { ...s.gitBranchCompareRequestStatusHeadByWorktree }
        delete nextSummary[worktreeId]
        delete nextChanges[worktreeId]
        delete nextRequestKey[worktreeId]
        delete nextRequestHead[worktreeId]
        return {
          gitBranchCompareSummaryByWorktree: nextSummary,
          gitBranchChangesByWorktree: nextChanges,
          gitBranchCompareRequestKeyByWorktree: nextRequestKey,
          gitBranchCompareRequestStatusHeadByWorktree: nextRequestHead
        }
      })
  }
}
