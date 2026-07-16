import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoById, useRepoMap, useWorktreeById } from '@/store/selectors'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getConnectionId } from '@/lib/connection-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { refreshGitStatusForWorktree } from './git-status-refresh'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import {
  hasInteractiveActiveGitStatusConsumer,
  shouldPollActiveGitStatus
} from '@/lib/passive-macos-app-data-access'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'
import { useGitStatusFileWatchRefresh } from './git-status-file-watch-refresh'
import { useGitStatusPushSignalRefresh } from './git-status-push-signal-refresh'
import { useStaleConflictOperationPolling } from './stale-conflict-operation-poll'
import {
  createGitStatusRefreshScheduler,
  type GitStatusRefreshReason,
  type GitStatusRefreshScheduler
} from './git-status-refresh-scheduler'

const STATUS_SAFETY_INTERVAL_MS = 60_000
const STATUS_ACTIVITY_DEBOUNCE_MS = 125
// Why: evidence-driven status refreshes must keep the pre-scheduler floor so
// sustained terminal/file signals can never run git back-to-back (#7983).
const STATUS_ACTIVITY_MIN_GAP_MS = 3000
// Why: status scans and remote conflict probes can take longer than their
// timers; duration-aware spacing prevents a slow task from running nonstop.
const SLOW_GIT_POLL_BACKOFF = {
  idleMultiplier: 5,
  changeSignalMultiplier: 1,
  maxIntervalMs: 5 * 60_000
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
  // Why: the huge flag must only pause evidence-free polling, not push-signal
  // refreshes — a fresh non-huge status result is the only thing that can
  // clear the flag, so gating every lane on it would deadlock the worktree
  // into stale status until an app restart.
  const shouldPollActiveWorktreeGitStatus =
    canFetchActiveWorktreeGitStatus &&
    !!activeWorktreeId &&
    !gitStatusHugeByWorktree?.[activeWorktreeId]
  const activeStatusPollScope = shouldPollActiveWorktreeGitStatus
    ? `${activeExecutionHostId}\0${activeWorktreeId}\0${worktreePath}`
    : null
  // Why: opening any git-status consumer (Source Control, Files, Checks, or an
  // editor file) must refresh promptly, matching the pre-scheduler behavior
  // where the interactive interval flip re-ran an immediate poll.
  const interactiveConsumerVisible = hasInteractiveActiveGitStatusConsumer(
    activeGitStatusPollingArgs
  )

  const runFetchStatus = useCallback(
    async (request: {
      reason: GitStatusRefreshReason
      signal: AbortSignal
      shouldApply: () => boolean
    }) => {
      // Why: eligibility can change between timer dispatch and task start.
      // Avoid launching work that its liveness guard would have to discard.
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
        const connectionId = getConnectionId(activeWorktreeId) ?? undefined
        await refreshGitStatusForWorktree({
          settings: getRightSidebarWorktreeRuntimeSettings(activeWorktreeId),
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId,
          pushTarget: activePushTarget,
          deps: {
            setGitStatus,
            updateWorktreeGitIdentity,
            setUpstreamStatus,
            fetchUpstreamStatus
          },
          request: {
            ...(request.reason === 'safety' ? { reuseLineStats: true } : {}),
            signal: request.signal,
            shouldApply: request.shouldApply
          }
        })
      } catch {
        // ignore
      }
    },
    [
      activePushTarget,
      activeWorktreeId,
      fetchUpstreamStatus,
      canFetchActiveWorktreeGitStatus,
      worktreePath,
      setGitStatus,
      setUpstreamStatus,
      updateWorktreeGitIdentity
    ]
  )

  // Why: the scheduler must survive harmless store rerenders so its in-flight,
  // trailing-signal, and safety-horizon state remain authoritative.
  const runFetchStatusRef = useRef(runFetchStatus)
  runFetchStatusRef.current = runFetchStatus
  const canApplyScheduledStatusRef = useRef(canFetchActiveWorktreeGitStatus)
  canApplyScheduledStatusRef.current = canFetchActiveWorktreeGitStatus
  const statusRefreshGenerationRef = useRef(0)

  const statusSchedulerRef = useRef<GitStatusRefreshScheduler | null>(null)
  useEffect(() => {
    const generation = ++statusRefreshGenerationRef.current
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
        slowTaskBackoff: SLOW_GIT_POLL_BACKOFF
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
    // Why: push-target changes must bump the generation so an in-flight refresh
    // captured against the old remote/branch can't apply or cache stale upstream
    // status for the new one.
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

  // Why: file, terminal, and metadata evidence share one scheduler window so
  // a single Git operation cannot fan out into several status subprocesses.
  const fetchStatusOnChangeSignal = useCallback(() => {
    statusSchedulerRef.current?.signal()
  }, [])

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
    enabled: canFetchActiveWorktreeGitStatus,
    fetchStatus: fetchStatusOnChangeSignal
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
