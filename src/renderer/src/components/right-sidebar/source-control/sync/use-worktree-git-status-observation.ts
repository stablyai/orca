import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { SourceControlScope } from '../panel/worktree-scope'
import { sourceControlFileWatchRuntimeEnvironmentId } from './worktree-git-owner-target'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import { useRepoById } from '@/store/repos/use-repository-catalog'
import { useWorktreeById } from '@/store/workspaces/selection/use-selected-worktree'
import { isGitRepoKind } from '../../../../../../shared/repo-kind'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { refreshGitStatusForWorktree } from './git-status-refresh'
import {
  isWindowVisible,
  windowPollSlowdown
} from '@/lib/window-activity/window-visibility-interval'
import { takeRecentWorkspaceSwitchWake } from '@/lib/workspace/activation/workspace-switch-user-act'
import { useRefreshOnHostContact } from './use-refresh-on-host-contact'
import { useGitStatusWindowPresence } from './use-git-status-window-presence'
import {
  hasInteractiveActiveGitStatusConsumer,
  shouldPollActiveGitStatus
} from '@/app-shell/platform/passive-macos-app-data-access'
import { resolveWorktreeGitCopyNow } from '@/lib/workspace/ownership/worktree-git-copy'
import { useGitStatusFileWatchRefresh } from './git-status-file-watch-refresh'
import { useGitStatusPushSignalRefresh } from './git-status-push-signal-refresh'
import { useGitStatusUpstreamRefWatch } from './use-git-status-upstream-ref-watch'
import { useWorktreeGitOwnerTarget } from './worktree-git-owner-target'
import { useGitStatusTurnCompletion } from './use-git-status-turn-completion'
import {
  admissionTierForGitStatusRefreshReason,
  createGitStatusRefreshPacing,
  createGitStatusRefreshScheduler,
  type GitStatusRefreshPacing,
  type GitStatusRefreshReason,
  type GitStatusRefreshScheduler
} from './git-status-refresh-scheduler'

const NO_OWNER_FILES: OpenFile[] = []

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

/** Returns a coalesced refresh that runs through this observer's scheduler, tier and apply guards. */
export function useWorktreeGitStatusObservation(
  owner: SourceControlScope | null,
  options: { enabled?: boolean } = {}
): () => void {
  const enabled = options.enabled ?? true
  const activeWorktreeId = useAppStore((s) => owner?.worktreeId ?? s.activeWorktreeId)
  const selectedWorktree = useWorktreeById(owner ? null : activeWorktreeId)
  const activeWorktree = owner?.worktree ?? selectedWorktree
  const activeExecutionHostId = useAppStore(
    (s) => owner?.executionHostId ?? getExecutionHostIdForWorktree(s, activeWorktreeId)
  )
  const fileWatchRuntimeEnvironmentId = useAppStore((state) =>
    owner ? sourceControlFileWatchRuntimeEnvironmentId(state, owner) : undefined
  )
  const updateWorktreeGitIdentity = useAppStore((s) => s.updateWorktreeGitIdentity)
  const setGitStatus = useAppStore((s) => s.setGitStatus)
  const huge = useAppStore((s) =>
    activeWorktreeId ? s.gitStatusHugeByWorktree[activeWorktreeId] : undefined
  )
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  const setUpstreamStatus = useAppStore((s) => s.setUpstreamStatus)
  const openFiles = useAppStore((s) => (owner ? NO_OWNER_FILES : s.openFiles))
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const rightSidebarExplorerView = useAppStore((s) => s.rightSidebarExplorerView)
  const pollingAllowed = useAppStore((s) =>
    owner
      ? options.enabled === true
      : shouldPollActiveGitStatus({
          activeWorktreeId,
          worktreePath: activeWorktree?.path ?? null,
          rightSidebarOpen: s.rightSidebarOpen,
          rightSidebarTab: s.rightSidebarTab,
          rightSidebarExplorerView: s.rightSidebarExplorerView,
          openFiles: s.openFiles
        })
  )
  const interactiveConsumerVisible = useAppStore((s) =>
    owner
      ? options.enabled === true
      : hasInteractiveActiveGitStatusConsumer({
          activeWorktreeId,
          worktreePath: activeWorktree?.path ?? null,
          rightSidebarOpen: s.rightSidebarOpen,
          rightSidebarTab: s.rightSidebarTab,
          rightSidebarExplorerView: s.rightSidebarExplorerView,
          openFiles: s.openFiles
        })
  )

  const worktreePath = activeWorktree?.path ?? null
  const activePushTarget = activeWorktree?.pushTarget
  const activeRepoId = activeWorktree?.repoId ?? null
  const selectedRepo = useRepoById(owner ? null : activeRepoId)
  const activeRepo = owner?.repo ?? selectedRepo
  const activeRepoSupportsGit = activeRepo ? isGitRepoKind(activeRepo) : false
  const activeConnectionId = activeRepo?.connectionId ?? null
  const isActiveConnectionReady = useAppStore(
    (s) =>
      !activeConnectionId || s.sshConnectionStates.get(activeConnectionId)?.status === 'connected'
  )
  const canFetchActiveWorktreeGitStatus =
    enabled &&
    !!activeWorktreeId &&
    !!worktreePath &&
    activeRepoSupportsGit &&
    pollingAllowed &&
    isActiveConnectionReady
  // Pause only evidence-free polling: gating signal refreshes too would prevent a fresh result from clearing huge status.
  const shouldPollActiveWorktreeGitStatus =
    canFetchActiveWorktreeGitStatus && !!activeWorktreeId && !huge
  const activeStatusPollScope = shouldPollActiveWorktreeGitStatus
    ? `${activeExecutionHostId}\0${activeWorktreeId}\0${worktreePath}`
    : null
  // Main binds one upstream ref (the selected worktree's); sections must not add per-tick resolutions.
  const publishUpstreamRefWatch = useGitStatusUpstreamRefWatch({
    enabled: canFetchActiveWorktreeGitStatus && !owner,
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
        const copy = resolveWorktreeGitCopyNow(activeWorktreeId, activeExecutionHostId)
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
      activeExecutionHostId,
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
  const canApplyScheduledStatusRef = useRef(canFetchActiveWorktreeGitStatus)
  useLayoutEffect(() => {
    runFetchStatusRef.current = runFetchStatus
    canApplyScheduledStatusRef.current = canFetchActiveWorktreeGitStatus
  }, [runFetchStatus, canFetchActiveWorktreeGitStatus])
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
        pacing,
        // Agents editing files behind another app must not drive (remote) git status every 3s.
        cadenceScale: windowPollSlowdown,
        activityCadenceScale: () => (windowPollSlowdown() === 1 ? 1 : 20)
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

  useGitStatusWindowPresence(
    statusSchedulerRef,
    canFetchActiveWorktreeGitStatus,
    activeStatusPollScope
  )

  useRefreshOnHostContact(activeExecutionHostId, statusSchedulerRef, canApplyScheduledStatusRef)

  const ownerTarget = useWorktreeGitOwnerTarget(activeWorktreeId, activeExecutionHostId)
  useGitStatusTurnCompletion(
    ownerTarget,
    activeExecutionHostId,
    activeWorktreeId,
    canFetchActiveWorktreeGitStatus,
    statusSchedulerRef
  )

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

  useGitStatusFileWatchRefresh({
    activeConnectionId,
    activeRepoSupportsGit,
    activeWorktreeId,
    enabled: canFetchActiveWorktreeGitStatus,
    runtimeEnvironmentId: fileWatchRuntimeEnvironmentId,
    fetchStatus: fetchStatusOnChangeSignal,
    gitStatusHugeByWorktree: activeWorktreeId ? { [activeWorktreeId]: huge } : {},
    isConnectionReady: () => isActiveConnectionReady,
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
    fetchStatus: fetchStatusOnChangeSignal
  })

  return useCallback(() => {
    statusSchedulerRef.current?.refreshNow()
  }, [])
}
