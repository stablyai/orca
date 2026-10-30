import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoById, useRepoMap, useWorktreeById } from '@/store/selectors'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { refreshGitStatusForWorktree } from './git-status-refresh'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import { takeRecentWorkspaceSwitchWake } from '@/lib/workspace-switch-user-act'
import {
  hasInteractiveActiveGitStatusConsumer,
  shouldPollActiveGitStatus
} from '@/lib/passive-macos-app-data-access'
import { resolveWorktreeGitCopyNow } from '@/lib/worktree-git-copy'
import { useGitStatusFileWatchRefresh } from './git-status-file-watch-refresh'
import { useGitStatusPushSignalRefresh } from './git-status-push-signal-refresh'
import { useStaleConflictOperationPolling } from './stale-conflict-operation-poll'
import { useGitStatusUpstreamRefWatch } from './use-git-status-upstream-ref-watch'
import {
  createGitStatusRefreshPacing,
  createGitStatusRefreshScheduler,
  type GitStatusRefreshPacing,
  type GitStatusRefreshReason,
  type GitStatusRefreshScheduler
} from './git-status-refresh-scheduler'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

const STATUS_SAFETY_INTERVAL_MS = 60_000
const STATUS_ACTIVITY_DEBOUNCE_MS = 125
// Retain the pre-scheduler floor so sustained change signals cannot run Git back-to-back (#7983).
const STATUS_ACTIVITY_MIN_GAP_MS = 3000
// Duration-aware spacing keeps slow scans/probes from running nonstop beyond their timer cadence.
export const SLOW_GIT_POLL_BACKOFF = {
  idleMultiplier: 1,
  changeSignalMultiplier: 1,
  maxIntervalMs: 5 * 60_000
}

export function admissionTierForGitStatusRefreshReason(
  reason: GitStatusRefreshReason
): 'status' | 'background' {
  return reason === 'safety' ? 'background' : 'status'
}

export function useGitStatusPolling(options: { enabled?: boolean } = {}): void {
  const enabled = options.enabled ?? true
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorktree = useWorktreeById(activeWorktreeId)
  const activeExecutionHostId = useAppStore((s) =>
    getExecutionHostIdForWorktree(s, activeWorktreeId)
  )
  const allWorktrees = useAllWorktrees()
  const updateWorktreeGitIdentity = useAppStore((s) => s.updateWorktreeGitIdentity)
  const setGitStatus = useAppStore((s) => s.setGitStatus)
  const gitStatusHugeByWorktree = useAppStore((s) => s.gitStatusHugeByWorktree)
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  const setUpstreamStatus = useAppStore((s) => s.setUpstreamStatus)
  const setConflictOperation = useAppStore((s) => s.setConflictOperation)
  const conflictOperationByWorktree = useAppStore((s) => s.gitConflictOperationByWorktree)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const rightSidebarExplorerView = useAppStore((s) => s.rightSidebarExplorerView)
  const openFiles = useAppStore((s) => s.openFiles)
  const repoMap = useRepoMap()

  const worktreePath = activeWorktree?.path ?? null
  const activePushTarget = activeWorktree?.pushTarget
  const activeRepoId = activeWorktree?.repoId ?? null
  const activeRepo = useRepoById(activeRepoId)
  const activeRepoSupportsGit = activeRepo ? isGitRepoKind(activeRepo) : false
  const activeConnectionId = activeRepo?.connectionId ?? null
  const isConnectionReady = useCallback(
    (connectionId: string | null | undefined): boolean =>
      !connectionId || sshConnectionStates.get(connectionId)?.status === 'connected',
    [sshConnectionStates]
  )
  const activeGitStatusPollingArgs = {
    activeWorktreeId,
    worktreePath,
    rightSidebarOpen,
    rightSidebarTab,
    rightSidebarExplorerView,
    openFiles
  }
  const isActiveConnectionReady = isConnectionReady(activeConnectionId)
  const canFetchActiveWorktreeGitStatus =
    enabled &&
    !!activeWorktreeId &&
    !!worktreePath &&
    activeRepoSupportsGit &&
    shouldPollActiveGitStatus(activeGitStatusPollingArgs) &&
    isActiveConnectionReady
  // Pause only evidence-free polling: gating signal refreshes too would prevent a fresh result from clearing huge status.
  const shouldPollActiveWorktreeGitStatus =
    canFetchActiveWorktreeGitStatus &&
    !!activeWorktreeId &&
    !gitStatusHugeByWorktree?.[activeWorktreeId]
  const activeStatusPollScope = shouldPollActiveWorktreeGitStatus
    ? `${activeExecutionHostId}\0${activeWorktreeId}\0${worktreePath}`
    : null
  // Opening any status consumer must refresh promptly, preserving the previous interactive-poll behavior.
  const interactiveConsumerVisible = hasInteractiveActiveGitStatusConsumer(
    activeGitStatusPollingArgs
  )

  const publishUpstreamRefWatch = useGitStatusUpstreamRefWatch({
    enabled: canFetchActiveWorktreeGitStatus,
    executionHostId: activeExecutionHostId,
    worktreeId: activeWorktreeId,
    worktreePath
  })

  const runFetchStatus = useCallback(
    async (request: {
      reason: GitStatusRefreshReason
      signal: AbortSignal
      shouldApply: () => boolean
    }) => {
      // Recheck eligibility after timer dispatch so changed liveness cannot launch stale work.
      if (
        request.signal.aborted ||
        !isWindowVisible() ||
        !canFetchActiveWorktreeGitStatus ||
        !activeWorktreeId ||
        !worktreePath
      ) {
        return
      }
      try {
        // Why one resolution: a same-path twin must not get this copy's transport, SSH target or answer.
        const copy = resolveWorktreeGitCopyNow(activeWorktreeId)
        if (!copy) {
          return
        }
        // Only the first status after the user's own switch here may start WSL (E9); polls, remounts
        // and restores stay gated.
        const wakeWslDistro = takeRecentWorkspaceSwitchWake(activeWorktreeId, 'git-status')
        await refreshGitStatusForWorktree({
          target: copy.transport,
          ownerHostId: copy.hostId,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId: copy.connectionId,
          pushTarget: activePushTarget,
          deps: { setGitStatus, updateWorktreeGitIdentity, setUpstreamStatus, fetchUpstreamStatus },
          request: {
            admissionTier: admissionTierForGitStatusRefreshReason(request.reason),
            ...(request.reason === 'safety' ? { reuseLineStats: true } : {}),
            signal: request.signal,
            shouldApply: request.shouldApply,
            onStatusAccepted: publishUpstreamRefWatch,
            ...(wakeWslDistro ? { wakeWslDistro: true } : {})
          }
        })
      } catch {}
    },
    [
      activePushTarget,
      activeWorktreeId,
      fetchUpstreamStatus,
      canFetchActiveWorktreeGitStatus,
      publishUpstreamRefWatch,
      worktreePath,
      setGitStatus,
      setUpstreamStatus,
      updateWorktreeGitIdentity
    ]
  )

  // Preserve scheduler lifetime across harmless rerenders so in-flight/trailing/pacing state remains authoritative.
  const runFetchStatusRef = useRef(runFetchStatus)
  runFetchStatusRef.current = runFetchStatus
  const canApplyScheduledStatusRef = useRef(canFetchActiveWorktreeGitStatus)
  canApplyScheduledStatusRef.current = canFetchActiveWorktreeGitStatus
  const statusRefreshGenerationRef = useRef(0)

  const statusSchedulerRef = useRef<GitStatusRefreshScheduler | null>(null)
  // Persist pacing per worktree across host/target scheduler rebuilds so flapping cannot bypass the minimum gap.
  const statusPacingRef = useRef<{
    key: string
    pacing: GitStatusRefreshPacing
  } | null>(null)
  useEffect(() => {
    const generation = ++statusRefreshGenerationRef.current
    const pacingKey = `${activeWorktreeId}\0${worktreePath}`
    let pacing =
      statusPacingRef.current?.key === pacingKey ? statusPacingRef.current.pacing : undefined
    if (!pacing) {
      pacing = createGitStatusRefreshPacing()
      statusPacingRef.current = { key: pacingKey, pacing }
    }
    const scheduler = createGitStatusRefreshScheduler(
      ({ reason, signal }) =>
        runFetchStatusRef.current({
          reason,
          signal,
          shouldApply: () =>
            statusRefreshGenerationRef.current === generation &&
            canApplyScheduledStatusRef.current &&
            !signal.aborted &&
            isWindowVisible()
        }),
      {
        safetyIntervalMs: STATUS_SAFETY_INTERVAL_MS,
        activityDebounceMs: STATUS_ACTIVITY_DEBOUNCE_MS,
        activityMinGapMs: STATUS_ACTIVITY_MIN_GAP_MS,
        slowTaskBackoff: SLOW_GIT_POLL_BACKOFF,
        pacing
      }
    )
    statusSchedulerRef.current = scheduler
    return () => {
      statusRefreshGenerationRef.current += 1
      scheduler.dispose()
      if (statusSchedulerRef.current === scheduler) {
        statusSchedulerRef.current = null
      }
    }
    // Target changes must invalidate in-flight results captured against an old remote/branch.
  }, [activeExecutionHostId, activePushTarget, activeWorktreeId, worktreePath])

  useEffect(() => {
    const reconcile = (catchUp: boolean): void => {
      const scheduler = statusSchedulerRef.current
      if (!scheduler) {
        return
      }
      if (!canFetchActiveWorktreeGitStatus || !isWindowVisible()) {
        scheduler.pause()
        return
      }
      if (activeStatusPollScope) {
        scheduler.resumeSafety()
        return
      }
      scheduler.suspendSafety()
      if (catchUp) {
        scheduler.refreshNow()
      }
    }
    reconcile(false)
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return
    }
    const handleVisibilityChange = (): void => reconcile(isWindowVisible())
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [activeStatusPollScope, canFetchActiveWorktreeGitStatus])

  const previousConsumerVisibilityRef = useRef({
    worktreeId: activeWorktreeId,
    visible: interactiveConsumerVisible,
    canFetch: canFetchActiveWorktreeGitStatus
  })
  useEffect(() => {
    const previous = previousConsumerVisibilityRef.current
    if (
      interactiveConsumerVisible &&
      previous.worktreeId === activeWorktreeId &&
      !previous.visible &&
      previous.canFetch &&
      canFetchActiveWorktreeGitStatus &&
      isWindowVisible()
    ) {
      statusSchedulerRef.current?.refreshNow()
    }
    previousConsumerVisibilityRef.current = {
      worktreeId: activeWorktreeId,
      visible: interactiveConsumerVisible,
      canFetch: canFetchActiveWorktreeGitStatus
    }
  }, [activeWorktreeId, canFetchActiveWorktreeGitStatus, interactiveConsumerVisible])

  // Coalesce file/terminal/metadata evidence so one Git operation cannot fan out status subprocesses.
  const fetchStatusOnChangeSignal = useCallback(() => {
    statusSchedulerRef.current?.signal()
  }, [])

  const getRepoWorktreePathsForSignal = useCallback(
    (repoId: string) =>
      (selectWorktreesByRepo(useAppStore.getState())[repoId] ?? []).map(
        (worktree) => worktree.path
      ),
    []
  )

  useGitStatusFileWatchRefresh({
    activeConnectionId,
    activeRepoSupportsGit,
    activeWorktreeId,
    enabled,
    fetchStatus: fetchStatusOnChangeSignal,
    gitStatusHugeByWorktree,
    isConnectionReady,
    openFiles,
    rightSidebarExplorerView,
    rightSidebarOpen,
    rightSidebarTab,
    worktreePath
  })

  useGitStatusPushSignalRefresh({
    activeRepoId,
    activeWorktreeId,
    activeWorktreePath: worktreePath,
    enabled: canFetchActiveWorktreeGitStatus,
    fetchStatus: fetchStatusOnChangeSignal,
    getRepoWorktreePaths: getRepoWorktreePathsForSignal
  })

  useStaleConflictOperationPolling({
    enabled,
    activeWorktreeId,
    allWorktrees,
    repoMap,
    conflictOperationByWorktree,
    setConflictOperation,
    isConnectionReady,
    slowTaskBackoff: SLOW_GIT_POLL_BACKOFF
  })
}
