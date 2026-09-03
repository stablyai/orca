import { useCallback, useEffect, useRef } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitBranchCompare, type RuntimeGitContext } from '@/runtime/runtime-git-client'
import { useAppStore } from '@/store'
import type { GitUpstreamStatus } from '../../../../../../shared/git-status-types'
import { shouldClearBranchCompareForMissingBase } from './base-ref-resolution'
import {
  shouldRefreshBranchCompareForRemoteStatus,
  shouldRefreshBranchCompareForStatusHead,
  type BranchCompareRemoteStatusSnapshot,
  type BranchCompareStatusHeadSnapshot
} from './compare-summary'
import { slowTaskRequiredIdleMs } from '../../coalesced-poll-runner'

// Why: 30s poll — slow runs idle for their own duration; explicit commit/remote/manual/base-ref refreshes still run immediately.
export const BRANCH_REFRESH_INTERVAL_MS = 30_000
const BRANCH_REFRESH_IDLE_MULTIPLIER = 1
const BRANCH_REFRESH_MAX_INTERVAL_MS = 5 * 60_000

type BranchCompareRefreshKind = 'immediate' | 'interval'

export function useSourceControlBranchCompare({
  activeRepoSettings,
  activeWorktreeId,
  worktreePath,
  compareBaseRef,
  isFolder,
  branchName,
  isBranchVisible,
  activeGitStatusHead,
  remoteStatus
}: {
  activeRepoSettings: RuntimeGitContext['settings']
  activeWorktreeId: string | null
  worktreePath: string | null
  compareBaseRef: string | null
  isFolder: boolean
  branchName: string
  isBranchVisible: boolean
  activeGitStatusHead: string | null
  remoteStatus: GitUpstreamStatus | undefined
}): {
  refreshBranchCompare: () => Promise<void>
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
} {
  const beginGitBranchCompareRequest = useAppStore((s) => s.beginGitBranchCompareRequest)
  const setGitBranchCompareResult = useAppStore((s) => s.setGitBranchCompareResult)
  const clearGitBranchCompare = useAppStore((s) => s.clearGitBranchCompare)
  const branchCompareInFlightRef = useRef(false)
  const branchCompareRerunRef = useRef<BranchCompareRefreshKind | null>(null)
  const branchCompareRunPromiseRef = useRef<Promise<void> | null>(null)
  const refreshBranchCompareRef = useRef<() => Promise<void>>(async () => {})
  const startBranchCompareRef = useRef<(kind: BranchCompareRefreshKind) => Promise<void>>(
    async () => {}
  )
  const branchComparePollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const branchComparePollEnabledRef = useRef(false)
  const branchCompareLastRunEndedAtRef = useRef(-Infinity)
  const branchCompareLastRunDurationRef = useRef(0)
  const branchCompareStatusHeadRef = useRef<BranchCompareStatusHeadSnapshot | null>(null)
  const branchCompareRemoteStatusRef = useRef<BranchCompareRemoteStatusSnapshot | null>(null)

  const runBranchCompare = useCallback(
    async (kind: BranchCompareRefreshKind) => {
      if (!activeWorktreeId || !worktreePath || !compareBaseRef || isFolder) {
        return
      }
      const requestKey = `${activeWorktreeId}:${compareBaseRef}:${Date.now()}`
      const existingSummary =
        useAppStore.getState().gitBranchCompareSummaryByWorktree[activeWorktreeId]
      // Why: only reset to 'loading' on the first request or a base-ref change; resetting on every poll caused a visible loading→error→loading flicker.
      const baseRefChanged = existingSummary && existingSummary.baseRef !== compareBaseRef
      const shouldResetToLoading = !existingSummary || baseRefChanged
      if (shouldResetToLoading) {
        beginGitBranchCompareRequest(activeWorktreeId, requestKey, compareBaseRef)
      } else {
        beginGitBranchCompareRequest(activeWorktreeId, requestKey, compareBaseRef, {
          preserveExistingSummary: true
        })
      }
      try {
        const connectionId = getConnectionId(activeWorktreeId) ?? undefined
        const result = await getRuntimeGitBranchCompare(
          {
            // Why: route the branch compare by the repo OWNER host, not the focused runtime.
            settings: activeRepoSettings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          compareBaseRef,
          kind === 'interval' ? 'background' : 'interactive'
        )
        setGitBranchCompareResult(activeWorktreeId, requestKey, result)
      } catch (error) {
        setGitBranchCompareResult(activeWorktreeId, requestKey, {
          summary: {
            baseRef: compareBaseRef,
            baseOid: null,
            compareRef: branchName,
            headOid: null,
            mergeBase: null,
            changedFiles: 0,
            status: 'error',
            errorMessage: error instanceof Error ? error.message : 'Branch compare failed'
          },
          entries: []
        })
      }
    },
    [
      activeRepoSettings,
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
      if (kind === 'immediate') {
        clearBranchComparePollTimer()
      }
      if (branchCompareInFlightRef.current) {
        if (kind === 'immediate' || branchCompareRerunRef.current === null) {
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
        // Why: keep one branch-compare chain in flight and collapse skipped ticks into one trailing refresh instead of stacking git subprocesses.
        try {
          await runBranchCompare(kind)
        } finally {
          const endedAt = Date.now()
          branchCompareLastRunEndedAtRef.current = endedAt
          branchCompareLastRunDurationRef.current = endedAt - startedAt
          branchCompareInFlightRef.current = false
          const rerunKind = branchCompareRerunRef.current
          branchCompareRerunRef.current = null
          if (rerunKind === 'immediate') {
            await refreshBranchCompareRef.current()
          } else if (rerunKind === 'interval') {
            scheduleBranchComparePoll()
          }
        }
      })()
      branchCompareRunPromiseRef.current = runPromise
      try {
        await runPromise
      } finally {
        if (branchCompareRunPromiseRef.current === runPromise) {
          branchCompareRunPromiseRef.current = null
        }
      }
    },
    [clearBranchComparePollTimer, runBranchCompare, scheduleBranchComparePoll]
  )
  const refreshBranchCompare = useCallback(
    () => startBranchCompare('immediate'),
    [startBranchCompare]
  )
  // Why: publish in an effect, not the render body — a discarded render must not install its callback. Declared first so the effects below see the fresh one.
  useEffect(() => {
    refreshBranchCompareRef.current = refreshBranchCompare
    startBranchCompareRef.current = startBranchCompare
  }, [refreshBranchCompare, startBranchCompare])

  useEffect(() => {
    if (!activeWorktreeId || !worktreePath || !isBranchVisible || !compareBaseRef || isFolder) {
      branchCompareStatusHeadRef.current = null
      return
    }
    const current = {
      baseRef: compareBaseRef,
      statusHead: activeGitStatusHead,
      worktreeId: activeWorktreeId
    }
    const previous = branchCompareStatusHeadRef.current
    branchCompareStatusHeadRef.current = current
    if (shouldRefreshBranchCompareForStatusHead(previous, current)) {
      void refreshBranchCompareRef.current()
    }
  }, [
    activeGitStatusHead,
    activeWorktreeId,
    compareBaseRef,
    isBranchVisible,
    isFolder,
    worktreePath
  ])

  useEffect(() => {
    if (!activeWorktreeId || !worktreePath || !isBranchVisible || !compareBaseRef || isFolder) {
      branchCompareRemoteStatusRef.current = null
      return
    }
    // Why: pushing a branch can move its remote base and ahead count without changing local HEAD, which the HEAD-change effect alone misses.
    const current = {
      ahead: remoteStatus?.ahead ?? null,
      baseRef: compareBaseRef,
      behind: remoteStatus?.behind ?? null,
      hasUpstream: remoteStatus?.hasUpstream ?? null,
      upstreamName: remoteStatus?.upstreamName ?? null,
      worktreeId: activeWorktreeId
    }
    const previous = branchCompareRemoteStatusRef.current
    branchCompareRemoteStatusRef.current = current
    if (shouldRefreshBranchCompareForRemoteStatus(previous, current)) {
      void refreshBranchCompareRef.current()
    }
  }, [
    activeWorktreeId,
    compareBaseRef,
    isBranchVisible,
    isFolder,
    remoteStatus?.ahead,
    remoteStatus?.behind,
    remoteStatus?.hasUpstream,
    remoteStatus?.upstreamName,
    worktreePath
  ])

  useEffect(() => {
    if (!activeWorktreeId || !worktreePath || !isBranchVisible || !compareBaseRef || isFolder) {
      return
    }
    // Why: HEAD changes refresh branch compare immediately; keep a visible-window fallback for base/remote updates that don't move HEAD.
    branchComparePollEnabledRef.current = true
    const stopInterval = installWindowVisibilityInterval({
      run: () => void startBranchCompareRef.current('interval'),
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
    // Why: when compare-base resolves to no base, drop the stale summary (gate on loaded upstream status to avoid flicker).
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
