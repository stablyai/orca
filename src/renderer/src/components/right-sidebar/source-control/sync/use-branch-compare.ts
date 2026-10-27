import { useCallback, useEffect, useRef } from 'react'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitBranchCompare } from '@/runtime/runtime-git-diff-client'
import { useAppStore } from '@/store'
import { createLoadingBranchCompareSummary } from '@/store/slices/editor/git/branch-compare-state'
import type { GitUpstreamStatus } from '../../../../../../shared/git-status-types'
import { shouldClearBranchCompareForMissingBase } from '../../../../../../shared/source-control-base-ref-resolution'
import { slowTaskRequiredIdleMs } from '../../coalesced-poll-runner'
import { useBranchCompareRefreshTriggers } from './use-branch-compare-refresh-triggers'

// Slow polls idle for their own duration; explicit mutation/base/manual refreshes remain immediate.
export const BRANCH_REFRESH_INTERVAL_MS = 30_000
const BRANCH_REFRESH_IDLE_MULTIPLIER = 1
const BRANCH_REFRESH_MAX_INTERVAL_MS = 5 * 60_000

type BranchCompareRefreshKind = 'immediate' | 'interval'

export function useSourceControlBranchCompare({
  activeRepoTarget,
  activeWorktreeId,
  worktreePath,
  compareBaseRef,
  isFolder,
  branchName,
  isBranchVisible,
  activeGitStatusHead,
  remoteStatus
}: {
  activeRepoTarget: RuntimeClientTarget | null
  activeWorktreeId: string | null
  worktreePath: string | null
  compareBaseRef: string | null
  isFolder: boolean
  branchName: string
  isBranchVisible: boolean
  activeGitStatusHead: string | null
  remoteStatus: GitUpstreamStatus | undefined
}) {
  const beginGitBranchCompareRequest = useAppStore((s) => s.beginGitBranchCompareRequest)
  const setGitBranchCompareResult = useAppStore((s) => s.setGitBranchCompareResult)
  const clearGitBranchCompare = useAppStore((s) => s.clearGitBranchCompare)
  const branchCompareInFlightRef = useRef(false)
  const branchCompareRerunRef = useRef<BranchCompareRefreshKind | null>(null)
  const branchCompareRunPromiseRef = useRef<Promise<void> | null>(null)
  const branchCompareRecoveryPendingRef = useRef(false)
  const refreshBranchCompareRef = useRef<() => Promise<void>>(async () => {})
  const recoverBranchCompareRef = useRef<() => Promise<void>>(async () => {})
  const startBranchCompareRef = useRef<(kind: BranchCompareRefreshKind) => Promise<void>>(
    async () => {}
  )
  const branchComparePollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const branchComparePollEnabledRef = useRef(false)
  const branchCompareLastRunEndedAtRef = useRef(-Infinity)
  const branchCompareLastRunDurationRef = useRef(0)

  const runBranchCompare = useCallback(
    async (kind: BranchCompareRefreshKind) => {
      if (!activeWorktreeId || !worktreePath || !compareBaseRef || isFolder) {
        return
      }
      const requestKey = `${activeWorktreeId}:${compareBaseRef}:${Date.now()}`
      const summary = useAppStore.getState().gitBranchCompareSummaryByWorktree[activeWorktreeId]
      beginGitBranchCompareRequest(activeWorktreeId, requestKey, compareBaseRef, {
        preserveExistingSummary: !!summary && summary.baseRef === compareBaseRef
      })
      try {
        const result = await getRuntimeGitBranchCompare(
          {
            // Compare on the repo owner, which may differ from the focused host.
            target: requireGitOwnerTarget(activeRepoTarget),
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId: getConnectionId(activeWorktreeId) ?? undefined
          },
          compareBaseRef,
          kind === 'interval' ? 'background' : 'interactive'
        )
        setGitBranchCompareResult(activeWorktreeId, requestKey, result)
      } catch (error) {
        setGitBranchCompareResult(activeWorktreeId, requestKey, {
          summary: {
            ...createLoadingBranchCompareSummary(compareBaseRef),
            compareRef: branchName,
            status: 'error',
            errorMessage: error instanceof Error ? error.message : 'Branch compare failed'
          },
          entries: []
        })
      }
    },
    [
      activeRepoTarget,
      activeWorktreeId,
      beginGitBranchCompareRequest,
      branchName,
      compareBaseRef,
      isFolder,
      setGitBranchCompareResult,
      worktreePath
    ]
  )

  const clearBranchComparePollTimer = useCallback((): void => {
    if (branchComparePollTimerRef.current !== null) {
      clearTimeout(branchComparePollTimerRef.current)
      branchComparePollTimerRef.current = null
    }
  }, [])

  const scheduleBranchComparePoll = useCallback((): void => {
    if (!branchComparePollEnabledRef.current || branchComparePollTimerRef.current !== null) {
      return
    }
    const now = Date.now()
    const requiredIdleMs = slowTaskRequiredIdleMs(
      branchCompareLastRunDurationRef.current,
      BRANCH_REFRESH_IDLE_MULTIPLIER,
      BRANCH_REFRESH_INTERVAL_MS,
      BRANCH_REFRESH_MAX_INTERVAL_MS
    )
    const allowedAt = branchCompareLastRunEndedAtRef.current + requiredIdleMs
    if (now >= allowedAt) {
      void startBranchCompareRef.current('interval')
      return
    }
    branchComparePollTimerRef.current = setTimeout(() => {
      branchComparePollTimerRef.current = null
      if (branchComparePollEnabledRef.current) {
        void startBranchCompareRef.current('interval')
      }
    }, allowedAt - now)
  }, [])

  const startBranchCompare = useCallback(
    async (kind: BranchCompareRefreshKind) => {
      if (kind !== 'interval') {
        clearBranchComparePollTimer()
      }
      if (branchCompareInFlightRef.current) {
        if (
          branchCompareRerunRef.current !== 'immediate' &&
          (kind !== 'interval' || branchCompareRerunRef.current === null)
        ) {
          branchCompareRerunRef.current = kind
        }
        return branchCompareRunPromiseRef.current ?? undefined
      }
      if (kind === 'interval') {
        const requiredIdleMs = slowTaskRequiredIdleMs(
          branchCompareLastRunDurationRef.current,
          BRANCH_REFRESH_IDLE_MULTIPLIER,
          BRANCH_REFRESH_INTERVAL_MS,
          BRANCH_REFRESH_MAX_INTERVAL_MS
        )
        if (Date.now() < branchCompareLastRunEndedAtRef.current + requiredIdleMs) {
          scheduleBranchComparePoll()
          return
        }
      }
      clearBranchComparePollTimer()
      branchCompareInFlightRef.current = true
      const startedAt = Date.now()
      const runPromise = (async (): Promise<void> => {
        // Serialize comparisons and collapse skipped ticks into one trailing refresh to bound Git subprocesses.
        try {
          await runBranchCompare(kind)
        } finally {
          const endedAt = Date.now()
          branchCompareLastRunEndedAtRef.current = endedAt
          branchCompareLastRunDurationRef.current = endedAt - startedAt
          branchCompareInFlightRef.current = false
          const rerunKind = branchCompareRerunRef.current
          branchCompareRerunRef.current = null
          const recoveryPending = branchCompareRecoveryPendingRef.current
          branchCompareRecoveryPendingRef.current = false
          if (rerunKind === 'immediate') {
            await refreshBranchCompareRef.current()
          } else if (recoveryPending) {
            await recoverBranchCompareRef.current()
          } else if (rerunKind === 'interval') {
            scheduleBranchComparePoll()
          }
        }
      })()
      branchCompareRunPromiseRef.current = runPromise
      await runPromise.finally(() => {
        if (branchCompareRunPromiseRef.current === runPromise) {
          branchCompareRunPromiseRef.current = null
        }
      })
    },
    [clearBranchComparePollTimer, runBranchCompare, scheduleBranchComparePoll]
  )
  const refreshBranchCompare = useCallback(
    () => startBranchCompare('immediate'),
    [startBranchCompare]
  )
  const recoverBranchCompare = useCallback((): Promise<void> => {
    const summary = useAppStore.getState().gitBranchCompareSummaryByWorktree[activeWorktreeId ?? '']
    // Recover visible data immediately when results are missing, failed, loading, or for another base.
    if (
      summary &&
      summary.status !== 'loading' &&
      summary.status !== 'error' &&
      summary.baseRef === compareBaseRef
    ) {
      scheduleBranchComparePoll()
      return Promise.resolve()
    }
    if (branchCompareInFlightRef.current) {
      branchCompareRecoveryPendingRef.current = true
      return branchCompareRunPromiseRef.current ?? Promise.resolve()
    }
    return refreshBranchCompareRef.current()
  }, [activeWorktreeId, compareBaseRef, scheduleBranchComparePoll])
  // Publish before consumer effects, never during render where discarded renders could install callbacks.
  useEffect(() => {
    refreshBranchCompareRef.current = refreshBranchCompare
    recoverBranchCompareRef.current = recoverBranchCompare
    startBranchCompareRef.current = startBranchCompare
  }, [recoverBranchCompare, refreshBranchCompare, startBranchCompare])

  useBranchCompareRefreshTriggers({
    activeWorktreeId,
    worktreePath,
    compareBaseRef,
    isFolder,
    isBranchVisible,
    activeGitStatusHead,
    remoteStatus,
    refreshBranchCompareRef
  })

  useEffect(() => {
    if (!activeWorktreeId || !worktreePath || !isBranchVisible || !compareBaseRef || isFolder) {
      return
    }
    // HEAD changes refresh immediately; visible polling catches base/remote changes that do not move HEAD.
    branchComparePollEnabledRef.current = true
    const stopInterval = installWindowVisibilityInterval({
      run: () => void startBranchCompareRef.current('interval'),
      runOnVisible: () => void recoverBranchCompareRef.current(),
      jitterOnVisible: true,
      intervalMs: BRANCH_REFRESH_INTERVAL_MS
    })
    return () => {
      branchComparePollEnabledRef.current = false
      clearBranchComparePollTimer()
      stopInterval()
    }
  }, [
    activeWorktreeId,
    clearBranchComparePollTimer,
    compareBaseRef,
    isBranchVisible,
    isFolder,
    worktreePath
  ])

  useEffect(() => {
    // Wait for loaded upstream status before clearing a missing base to avoid flicker.
    if (
      !activeWorktreeId ||
      !shouldClearBranchCompareForMissingBase({
        isFolder,
        compareBaseRef,
        remoteStatus
      })
    ) {
      return
    }
    clearGitBranchCompare(activeWorktreeId)
  }, [activeWorktreeId, clearGitBranchCompare, compareBaseRef, isFolder, remoteStatus])

  return { refreshBranchCompare, refreshBranchCompareRef }
}
