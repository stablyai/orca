import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoById, useRepoMap, useWorktreeById } from '@/store/selectors'
import type { GitConflictOperation } from '../../../../shared/types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitConflictOperation } from '@/runtime/runtime-git-client'
import { refreshGitStatusForWorktree } from './git-status-refresh'
import { type CoalescedPollRunner, createCoalescedPollRunner } from './coalesced-poll-runner'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import {
  hasInteractiveActiveGitStatusConsumer,
  shouldPollActiveGitStatus
} from '@/lib/passive-macos-app-data-access'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'
import { useGitStatusFileWatchRefresh } from './git-status-file-watch-refresh'
import { useGitStatusPushSignalRefresh } from './git-status-push-signal-refresh'

const MIN_STATUS_REFRESH_INTERVAL_MS = 3000
const INTERACTIVE_STATUS_POLL_INTERVAL_MS = MIN_STATUS_REFRESH_INTERVAL_MS
// Why: file-watch refreshes cover content changes and push signals (repo
// metadata watch, shell command completion) cover branch switches; the
// terminal-only poll is a last-resort backstop for shells without either.
const TERMINAL_ONLY_STATUS_POLL_INTERVAL_MS = 30_000
// Why: on a large monorepo one status refresh can take tens of seconds, so the
// fixed 3s gap kept a git process running almost continuously while the
// workspace was idle (#7983). Evidence-free ticks wait 5x the previous poll
// duration (~1/6 duty cycle); change signals wait only 1x so real changes in a
// slow repo still surface promptly; the cap bounds worst-case staleness.
const SLOW_GIT_POLL_BACKOFF = {
  idleMultiplier: 5,
  changeSignalMultiplier: 1,
  maxIntervalMs: 5 * 60_000
}

export function useGitStatusPolling(options: { enabled?: boolean } = {}): void {
  const enabled = options.enabled ?? true
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorktree = useWorktreeById(activeWorktreeId)
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
  const shouldPollActiveWorktreeGitStatus =
    enabled &&
    !!activeWorktreeId &&
    !!worktreePath &&
    activeRepoSupportsGit &&
    shouldPollActiveGitStatus(activeGitStatusPollingArgs) &&
    isActiveConnectionReady &&
    !gitStatusHugeByWorktree?.[activeWorktreeId]
  const activeStatusPollIntervalMs = hasInteractiveActiveGitStatusConsumer(
    activeGitStatusPollingArgs
  )
    ? INTERACTIVE_STATUS_POLL_INTERVAL_MS
    : TERMINAL_ONLY_STATUS_POLL_INTERVAL_MS
  const activeStatusPollScope = shouldPollActiveWorktreeGitStatus ? activeWorktreeId : null

  // Why: build a list of non-active worktrees that still have a known conflict
  // operation (merge/rebase/cherry-pick). These need lightweight polling so
  // their sidebar badges clear when the operation finishes — the full git status
  // poll only covers the active worktree.
  const staleConflictWorktrees = useMemo(() => {
    const result: { id: string; path: string }[] = []
    for (const [worktreeId, op] of Object.entries(conflictOperationByWorktree)) {
      if (worktreeId === activeWorktreeId || op === 'unknown') {
        continue
      }
      const worktree = allWorktrees.find((entry) => entry.id === worktreeId)
      if (worktree) {
        const repo = repoMap.get(worktree.repoId)
        if (repo && !isGitRepoKind(repo)) {
          continue
        }
        result.push({ id: worktree.id, path: worktree.path })
      }
    }
    return result
  }, [allWorktrees, conflictOperationByWorktree, activeWorktreeId, repoMap])

  const runFetchStatus = useCallback(async () => {
    // Why: a backoff-deferred run can fire long after the window hides; skip
    // the scan instead of running tens of seconds of git work nobody can see.
    // The becoming-visible run catches up via the change-signal lane.
    if (!isWindowVisible()) {
      return
    }
    if (!shouldPollActiveWorktreeGitStatus || !activeWorktreeId || !worktreePath) {
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
        }
      })
    } catch {
      // ignore
    }
  }, [
    activePushTarget,
    activeWorktreeId,
    fetchUpstreamStatus,
    shouldPollActiveWorktreeGitStatus,
    worktreePath,
    setGitStatus,
    setUpstreamStatus,
    updateWorktreeGitIdentity
  ])

  // Why: the runner must survive rerenders so `lastRunEndedAt` and `inFlight`
  // are never reset by a UI-state change mid-burst (e.g. openFiles update while
  // git is still running). A ref keeps one runner per active-worktree lifetime;
  // `runFetchStatusRef` lets the runner always call the latest closure without
  // being recreated. The runner is disposed and replaced only when the active
  // worktree changes or the hook unmounts.
  const runFetchStatusRef = useRef(runFetchStatus)
  runFetchStatusRef.current = runFetchStatus

  const statusPollRunnerRef = useRef<CoalescedPollRunner | null>(null)
  useEffect(() => {
    const runner = createCoalescedPollRunner(() => runFetchStatusRef.current(), {
      minIntervalMs: MIN_STATUS_REFRESH_INTERVAL_MS,
      slowTaskBackoff: SLOW_GIT_POLL_BACKOFF
    })
    statusPollRunnerRef.current = runner
    return () => {
      runner.dispose()
      statusPollRunnerRef.current = null
    }
  }, [activeWorktreeId])

  const fetchStatus = useCallback(() => {
    statusPollRunnerRef.current?.run()
  }, [])

  // Why: file-watch and push signals carry evidence something changed, so they
  // take the runner's short-backoff lane instead of evidence-free tick pacing.
  const fetchStatusOnChangeSignal = useCallback(() => {
    statusPollRunnerRef.current?.run({ changeSignal: true })
  }, [])

  useEffect(() => {
    if (!activeStatusPollScope) {
      return
    }
    // Why: this root-level poll should pause while hidden, but visible
    // unfocused windows still need fresh status for second-display workflows.
    // Change signals are dropped while hidden, so the becoming-visible run
    // rides the short-backoff lane to catch up on anything that was missed.
    return installWindowVisibilityInterval({
      run: fetchStatus,
      runOnVisible: fetchStatusOnChangeSignal,
      intervalMs: activeStatusPollIntervalMs
    })
  }, [activeStatusPollIntervalMs, activeStatusPollScope, fetchStatus, fetchStatusOnChangeSignal])

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
    enabled: shouldPollActiveWorktreeGitStatus,
    fetchStatus: fetchStatusOnChangeSignal
  })

  // Why: poll conflict operation for non-active worktrees that have a stale
  // non-unknown operation. This is a lightweight fs-only check (no git status)
  // so it won't cause performance issues even with many worktrees.
  useEffect(() => {
    if (!enabled) {
      return
    }
    if (staleConflictWorktrees.length === 0) {
      return
    }

    const pollStale = async (): Promise<void> => {
      // Why: a backoff-deferred run can fire long after the window hides; skip
      // the probe instead of running SSH/RPC work nobody can see. The
      // becoming-visible run catches up via the change-signal lane.
      if (!isWindowVisible()) {
        return
      }
      for (const { id, path } of staleConflictWorktrees) {
        try {
          const connectionId = getConnectionId(id) ?? undefined
          // Why: after explicit SSH disconnect the provider is intentionally
          // gone; keep remote polling quiet until the target reconnects.
          if (!isConnectionReady(connectionId)) {
            continue
          }
          const op = (await getRuntimeGitConflictOperation({
            settings: getRightSidebarWorktreeRuntimeSettings(id),
            worktreeId: id,
            worktreePath: path,
            connectionId
          })) as GitConflictOperation
          setConflictOperation(id, op)
        } catch {
          // ignore — worktree may have been removed
        }
      }
    }

    // Why: remote conflict probes can exceed the 3s interval. Keep one poll in
    // flight, coalesce skipped ticks into one trailing pass, and back off after
    // slow probe chains so stale badges catch up without stacking SSH/RPC work.
    const pollRunner = createCoalescedPollRunner(pollStale, {
      slowTaskBackoff: SLOW_GIT_POLL_BACKOFF
    })
    // Why: conflict badges are visible sidebar state; keep them fresh in
    // visible unfocused windows, but do not poll disconnected hidden windows.
    // The becoming-visible run rides the short-backoff lane so badges catch
    // up promptly after a hidden stretch.
    const stopVisiblePoll = installWindowVisibilityInterval({
      run: () => pollRunner.run(),
      runOnVisible: () => pollRunner.run({ changeSignal: true }),
      intervalMs: MIN_STATUS_REFRESH_INTERVAL_MS
    })
    return () => {
      pollRunner.dispose()
      stopVisiblePoll()
    }
  }, [enabled, staleConflictWorktrees, setConflictOperation, isConnectionReady])
}
