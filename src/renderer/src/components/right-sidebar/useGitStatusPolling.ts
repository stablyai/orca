import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoById, useRepoMap, useWorktreeById } from '@/store/selectors'
import type { GitConflictOperation } from '../../../../shared/types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitConflictOperation } from '@/runtime/runtime-git-client'
import { refreshGitStatusForWorktree } from './git-status-refresh'
import { createCoalescedPollRunner } from './coalesced-poll-runner'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { shouldPollActiveGitStatus } from '@/lib/passive-macos-app-data-access'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'

const POLL_INTERVAL_MS = 3000

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
  const statusPollInFlightRef = useRef(false)
  const statusPollRerunRef = useRef(false)
  const fetchStatusRef = useRef<() => void>(() => {})

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
    if (!enabled) {
      return
    }
    if (!activeWorktreeId || !worktreePath) {
      return
    }
    if (
      !shouldPollActiveGitStatus({
        activeWorktreeId,
        worktreePath,
        rightSidebarOpen,
        rightSidebarTab,
        rightSidebarExplorerView,
        openFiles
      }) ||
      !activeRepoSupportsGit
    ) {
      return
    }
    if (!isConnectionReady(activeConnectionId)) {
      return
    }
    // Why: once a repo's status was truncated at the entry limit, re-running git
    // status every 3s just re-does expensive work and re-truncates. Pause the
    // automatic poll while huge (a manual refresh still goes through its own
    // path); resolving the changes (e.g. .gitignoring the huge folder) clears
    // the flag and polling resumes. Mirrors a "huge repo" disabling auto status.
    if (gitStatusHugeByWorktree?.[activeWorktreeId]) {
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
    activeRepoSupportsGit,
    activeConnectionId,
    activePushTarget,
    activeWorktreeId,
    enabled,
    fetchUpstreamStatus,
    gitStatusHugeByWorktree,
    isConnectionReady,
    openFiles,
    rightSidebarExplorerView,
    rightSidebarOpen,
    rightSidebarTab,
    worktreePath,
    setGitStatus,
    setUpstreamStatus,
    updateWorktreeGitIdentity
  ])

  const fetchStatus = useCallback(() => {
    if (statusPollInFlightRef.current) {
      statusPollRerunRef.current = true
      return
    }
    statusPollInFlightRef.current = true
    // Why: git status can exceed the 3s poll interval on large repos. Keep at
    // most one subprocess chain in flight, then run one trailing refresh if a
    // tick was skipped so the UI catches up without process pileups.
    void runFetchStatus().finally(() => {
      statusPollInFlightRef.current = false
      if (statusPollRerunRef.current) {
        statusPollRerunRef.current = false
        fetchStatusRef.current()
      }
    })
  }, [runFetchStatus])
  fetchStatusRef.current = fetchStatus

  useEffect(() => {
    if (!enabled) {
      return
    }
    // Why: this root-level poll should pause while hidden, but visible
    // unfocused windows still need fresh status for second-display workflows.
    return installWindowVisibilityInterval({ run: fetchStatus, intervalMs: POLL_INTERVAL_MS })
  }, [enabled, fetchStatus])

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
    // flight and coalesce skipped ticks into one trailing pass so stale badges
    // catch up without stacking SSH/RPC work.
    const pollRunner = createCoalescedPollRunner(pollStale)
    // Why: conflict badges are visible sidebar state; keep them fresh in
    // visible unfocused windows, but do not poll disconnected hidden windows.
    const stopVisiblePoll = installWindowVisibilityInterval({
      run: () => pollRunner.run(),
      intervalMs: POLL_INTERVAL_MS
    })
    return () => {
      pollRunner.dispose()
      stopVisiblePoll()
    }
  }, [enabled, staleConflictWorktrees, setConflictOperation, isConnectionReady])
}
