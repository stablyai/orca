import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import {
  areGitStatusEntriesEqual,
  areTrackedConflictMapsEqual,
  reconcileOpenFilesForStatus
} from '../git/git-status-reconciliation'
import {
  branchCompareMatchesStatusHead,
  createLoadingBranchCompareSummary,
  getKnownGitHead
} from '../git/branch-compare-state'

export function createGitStatusActions(
  set: EditorSet,
  _get: EditorGet
): Pick<
  EditorSlice,
  | 'gitStatusByWorktree'
  | 'gitStatusHeadByWorktree'
  | 'gitStatusHugeByWorktree'
  | 'gitBranchLineTotalByWorktree'
  | 'gitIgnoredPathsByWorktree'
  | 'gitConflictOperationByWorktree'
  | 'trackedConflictPathsByWorktree'
  | 'trackConflictPath'
  | 'setGitStatus'
  | 'setConflictOperation'
> {
  return {
    gitStatusByWorktree: {},
    gitStatusHeadByWorktree: {},
    gitStatusHugeByWorktree: {},
    gitBranchLineTotalByWorktree: {},
    gitIgnoredPathsByWorktree: {},
    gitConflictOperationByWorktree: {},
    trackedConflictPathsByWorktree: {},
    trackConflictPath: (worktreeId, path, conflictKind) =>
      set((s) => {
        const nextTracked = {
          ...s.trackedConflictPathsByWorktree[worktreeId],
          [path]: conflictKind
        }
        return {
          trackedConflictPathsByWorktree: {
            ...s.trackedConflictPathsByWorktree,
            [worktreeId]: nextTracked
          }
        }
      }),
    // Why: session-local conflict tracking (Resolved-locally) lives only in the renderer; main returns raw git status, so the renderer owns conflictStatusSource.
    setGitStatus: (worktreeId, status) =>
      set((s) => {
        const hadStatusEntry = Object.hasOwn(s.gitStatusByWorktree, worktreeId)
        const prevEntries = s.gitStatusByWorktree[worktreeId] ?? []
        const prevOperation = s.gitConflictOperationByWorktree[worktreeId] ?? 'unknown'
        const currentTracked = { ...s.trackedConflictPathsByWorktree[worktreeId] }
        // Why: main process doesn't set conflictStatusSource; stamp 'git' here for live u-records ('session' is stamped below for Resolved-locally).
        const normalizedEntries = status.entries.map((entry) =>
          entry.conflictStatus === 'unresolved'
            ? { ...entry, conflictStatusSource: 'git' as const }
            : entry
        )
        const unresolvedEntries = normalizedEntries.filter(
          (entry) => entry.conflictStatus === 'unresolved' && entry.conflictKind
        )
        const unresolvedByPath = new Map(unresolvedEntries.map((entry) => [entry.path, entry]))
        const statusIsComplete = status.didHitLimit !== true
        // Why: a capped snapshot cannot prove that an omitted conflict operation ended.
        const nextOperation =
          !statusIsComplete && status.conflictOperation === 'unknown'
            ? prevOperation
            : status.conflictOperation

        // Why: operation → 'unknown' with zero unresolved means an abort (git merge --abort), not resolution; clear tracked paths instead of marking each "Resolved locally".
        if (
          statusIsComplete &&
          nextOperation === 'unknown' &&
          prevOperation !== 'unknown' &&
          unresolvedByPath.size === 0
        ) {
          for (const path of Object.keys(currentTracked)) {
            delete currentTracked[path]
          }
        }

        const nextEntries = normalizedEntries.map((entry) => {
          if (entry.conflictStatus === 'unresolved') {
            return entry
          }
          const trackedConflictKind = currentTracked[entry.path]
          if (!trackedConflictKind) {
            return entry
          }
          return {
            ...entry,
            conflictKind: trackedConflictKind,
            conflictStatus: 'resolved_locally' as const,
            conflictStatusSource: 'session' as const
          }
        })

        if (statusIsComplete) {
          const visiblePaths = new Set(nextEntries.map((entry) => entry.path))
          for (const path of Object.keys(currentTracked)) {
            if (!visiblePaths.has(path) && !unresolvedByPath.has(path)) {
              delete currentTracked[path]
            }
          }
        }

        const nextOpenFiles = reconcileOpenFilesForStatus(
          s.openFiles,
          worktreeId,
          nextEntries,
          statusIsComplete
        )
        const statusUnchanged = hadStatusEntry && areGitStatusEntriesEqual(prevEntries, nextEntries)
        const trackedUnchanged = areTrackedConflictMapsEqual(
          s.trackedConflictPathsByWorktree[worktreeId] ?? {},
          currentTracked
        )
        const openFilesUnchanged = nextOpenFiles === s.openFiles
        const operationUnchanged = prevOperation === nextOperation

        const prevIgnored = s.gitIgnoredPathsByWorktree[worktreeId]
        const nextIgnored = status.ignoredPaths ?? []
        const ignoredUnchanged =
          prevIgnored !== undefined &&
          prevIgnored.length === nextIgnored.length &&
          prevIgnored.every((p, i) => p === nextIgnored[i])

        const prevHuge = s.gitStatusHugeByWorktree[worktreeId]
        const nextHuge = status.didHitLimit ? { limit: nextEntries.length } : undefined
        const hugeUnchanged = (prevHuge?.limit ?? null) === (nextHuge?.limit ?? null)

        const prevBranchLineTotal = s.gitBranchLineTotalByWorktree[worktreeId] ?? null
        // Why: an omitted field means "not computed on this pass" — soft-deadline
        // miss, cooldown, old host — not "zero", so dropping it blanks a published
        // chip between polls. Staleness is handled where it can be: the host
        // carries its cache forward, and SourceControl hides any total whose
        // mergeBase no longer matches the fork point. A capped listing skips the
        // ranged diff outright, so nothing will refresh it — clear it there.
        const nextBranchLineTotal = status.didHitLimit
          ? null
          : (status.branchLineTotal ?? prevBranchLineTotal)
        const branchLineTotalUnchanged =
          prevBranchLineTotal === nextBranchLineTotal ||
          (prevBranchLineTotal !== null &&
            nextBranchLineTotal !== null &&
            prevBranchLineTotal.added === nextBranchLineTotal.added &&
            prevBranchLineTotal.removed === nextBranchLineTotal.removed &&
            prevBranchLineTotal.mergeBase === nextBranchLineTotal.mergeBase &&
            (prevBranchLineTotal.test?.added ?? null) ===
              (nextBranchLineTotal.test?.added ?? null) &&
            (prevBranchLineTotal.test?.removed ?? null) ===
              (nextBranchLineTotal.test?.removed ?? null) &&
            (prevBranchLineTotal.generated?.added ?? null) ===
              (nextBranchLineTotal.generated?.added ?? null) &&
            (prevBranchLineTotal.generated?.removed ?? null) ===
              (nextBranchLineTotal.generated?.removed ?? null))

        const prevStatusHead = s.gitStatusHeadByWorktree[worktreeId]
        const nextStatusHead = getKnownGitHead(status.head)
        const statusHeadUnchanged = prevStatusHead === nextStatusHead

        const prevBranchSummary = s.gitBranchCompareSummaryByWorktree[worktreeId]
        // Why: a compare request can finish after git status observed a new HEAD; reject the stale snapshot before it renders a false clean state.
        const shouldInvalidateBranchCompare =
          !statusHeadUnchanged &&
          nextStatusHead !== undefined &&
          prevBranchSummary?.status === 'ready' &&
          !branchCompareMatchesStatusHead(prevBranchSummary, nextStatusHead)

        if (
          statusUnchanged &&
          trackedUnchanged &&
          openFilesUnchanged &&
          operationUnchanged &&
          ignoredUnchanged &&
          hugeUnchanged &&
          branchLineTotalUnchanged &&
          statusHeadUnchanged &&
          !shouldInvalidateBranchCompare
        ) {
          return s
        }

        const nextBranchLineTotalMap = branchLineTotalUnchanged
          ? s.gitBranchLineTotalByWorktree
          : nextBranchLineTotal
            ? { ...s.gitBranchLineTotalByWorktree, [worktreeId]: nextBranchLineTotal }
            : (() => {
                const copy = { ...s.gitBranchLineTotalByWorktree }
                delete copy[worktreeId]
                return copy
              })()

        const nextHugeMap = hugeUnchanged
          ? s.gitStatusHugeByWorktree
          : nextHuge
            ? { ...s.gitStatusHugeByWorktree, [worktreeId]: nextHuge }
            : (() => {
                const copy = { ...s.gitStatusHugeByWorktree }
                delete copy[worktreeId]
                return copy
              })()

        const nextStatusHeadMap = statusHeadUnchanged
          ? s.gitStatusHeadByWorktree
          : nextStatusHead
            ? { ...s.gitStatusHeadByWorktree, [worktreeId]: nextStatusHead }
            : (() => {
                const copy = { ...s.gitStatusHeadByWorktree }
                delete copy[worktreeId]
                return copy
              })()
        const nextBranchCompareSummaries = shouldInvalidateBranchCompare
          ? {
              ...s.gitBranchCompareSummaryByWorktree,
              [worktreeId]: createLoadingBranchCompareSummary(prevBranchSummary.baseRef)
            }
          : s.gitBranchCompareSummaryByWorktree
        const nextBranchChanges = shouldInvalidateBranchCompare
          ? { ...s.gitBranchChangesByWorktree, [worktreeId]: [] }
          : s.gitBranchChangesByWorktree

        return {
          openFiles: nextOpenFiles,
          gitStatusHugeByWorktree: nextHugeMap,
          gitBranchLineTotalByWorktree: nextBranchLineTotalMap,
          gitStatusHeadByWorktree: nextStatusHeadMap,
          gitStatusByWorktree: statusUnchanged
            ? s.gitStatusByWorktree
            : { ...s.gitStatusByWorktree, [worktreeId]: nextEntries },
          gitIgnoredPathsByWorktree: ignoredUnchanged
            ? s.gitIgnoredPathsByWorktree
            : { ...s.gitIgnoredPathsByWorktree, [worktreeId]: nextIgnored },
          gitConflictOperationByWorktree: operationUnchanged
            ? s.gitConflictOperationByWorktree
            : { ...s.gitConflictOperationByWorktree, [worktreeId]: nextOperation },
          trackedConflictPathsByWorktree: trackedUnchanged
            ? s.trackedConflictPathsByWorktree
            : { ...s.trackedConflictPathsByWorktree, [worktreeId]: currentTracked },
          gitBranchCompareSummaryByWorktree: nextBranchCompareSummaries,
          gitBranchChangesByWorktree: nextBranchChanges
        }
      }),
    setConflictOperation: (worktreeId, operation) =>
      set((s) => {
        const prev = s.gitConflictOperationByWorktree[worktreeId] ?? 'unknown'
        if (prev === operation) {
          return s
        }
        // Why: when the operation clears on a non-active worktree, also clear tracked conflict paths — same as setGitStatus does for the active one.
        const nextTracked =
          operation === 'unknown' && prev !== 'unknown'
            ? {}
            : s.trackedConflictPathsByWorktree[worktreeId]
        const trackedUnchanged = nextTracked === s.trackedConflictPathsByWorktree[worktreeId]
        return {
          gitConflictOperationByWorktree: {
            ...s.gitConflictOperationByWorktree,
            [worktreeId]: operation
          },
          ...(trackedUnchanged
            ? {}
            : {
                trackedConflictPathsByWorktree: {
                  ...s.trackedConflictPathsByWorktree,
                  [worktreeId]: nextTracked
                }
              })
        }
      })
  }
}
