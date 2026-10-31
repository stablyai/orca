import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { summarizeGitStatus, useWorktreeChangeSummaryStore } from '@/store/worktree-change-summary'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import { isMacAppDataPath } from '@/lib/passive-macos-app-data-access'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'
import type { GitStatusMetadataChangedEvent, Worktree } from '../../../../shared/worktree/types'
import {
  getWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../shared/worktree/host-qualified-identity'
import { createCoalescedPollRunner } from '../right-sidebar/coalesced-poll-runner'
import { isGitStatusSignalForWorktree } from '../right-sidebar/git-status-signal-attribution'
import { SLOW_GIT_POLL_BACKOFF } from '../right-sidebar/useGitStatusPolling'
import { resolveWorktreeStatusReadContext } from './worktree-status-read-context'
import {
  isActiveWorktreeRow,
  selectWorktreeChangeRefreshTargets
} from './worktree-change-refresh-targets'

const CHANGE_SUMMARY_TICK_MS = 15_000

function findActiveWorktree(state: AppState): Worktree | null {
  for (const worktrees of Object.values(selectWorktreesByRepo(state))) {
    const active = worktrees.find((worktree) =>
      isActiveWorktreeRow(worktree, state.activeWorktreeId, state.activeWorkspaceExecutionHostId)
    )
    if (active) {
      return active
    }
  }
  return null
}

function isConnectionReady(state: AppState, connectionId: string | undefined): boolean {
  return !connectionId || state.sshConnectionStates.get(connectionId)?.status === 'connected'
}

/** Keep sidebar change stripes current: active status is mirrored, visible inactive cards are read in the background. */
export function useWorktreeChangeSummaryRefresh({ enabled }: { enabled: boolean }): void {
  const showChanges = useAppStore((s) => s.settings?.showWorktreeUncommittedChanges !== false)
  const active = enabled && showChanges

  useEffect(() => {
    if (!active) {
      return
    }
    let disposed = false
    const controller = new AbortController()
    const lastReadAtByIdentity = new Map<HostScopedWorktreeKey, number>()
    const signaledIdentities = new Set<HostScopedWorktreeKey>()
    const summaries = useWorktreeChangeSummaryStore.getState()

    // The active checkout is already polled; reuse it so leaving a workspace keeps a fresh stripe.
    const mirrorActiveStatus = (state: AppState): void => {
      const worktree = findActiveWorktree(state)
      const entries = worktree ? state.gitStatusByWorktree[worktree.id] : undefined
      if (!worktree || !entries) {
        return
      }
      const identity = getWorktreeHostIdentity(worktree)
      const huge = state.gitStatusHugeByWorktree[worktree.id]
      lastReadAtByIdentity.set(identity, Date.now())
      summaries.setSummary(
        identity,
        huge ? { changeCount: huge.limit, capped: true } : summarizeGitStatus({ entries })
      )
    }

    const refreshVisible = async (): Promise<void> => {
      if (!isWindowVisible()) {
        return
      }
      const state = useAppStore.getState()
      const targets = selectWorktreeChangeRefreshTargets({
        visibleWorktrees: useWorktreeChangeSummaryStore.getState().visibleWorktrees,
        activeWorktreeId: state.activeWorktreeId,
        activeExecutionHostId: state.activeWorkspaceExecutionHostId,
        lastReadAtByIdentity,
        signaledIdentities,
        now: Date.now(),
        isProtectedPath: (path) => isMacAppDataPath(path)
      })
      // Sequential reads keep this to one background git child at a time.
      for (const worktree of targets) {
        if (disposed || !isWindowVisible()) {
          return
        }
        const identity = getWorktreeHostIdentity(worktree)
        signaledIdentities.delete(identity)
        lastReadAtByIdentity.set(identity, Date.now())
        const current = useAppStore.getState()
        const context = resolveWorktreeStatusReadContext(current, worktree)
        if (!context || !isConnectionReady(current, context.connectionId)) {
          continue
        }
        try {
          const status = await getRuntimeGitStatus(context, {
            admissionTier: 'background',
            includeLineStats: false,
            signal: controller.signal
          })
          if (!disposed) {
            summaries.setSummary(identity, summarizeGitStatus(status))
          }
        } catch {
          // Removed worktrees and dropped hosts fail here; the next stale pass retries.
        }
      }
    }

    const runner = createCoalescedPollRunner(refreshVisible, {
      slowTaskBackoff: SLOW_GIT_POLL_BACKOFF
    })
    const signal = (matches: (worktree: Worktree) => boolean): void => {
      let found = false
      for (const worktree of useWorktreeChangeSummaryStore.getState().visibleWorktrees) {
        if (matches(worktree)) {
          signaledIdentities.add(getWorktreeHostIdentity(worktree))
          found = true
        }
      }
      if (found) {
        runner.run({ changeSignal: true })
      }
    }

    mirrorActiveStatus(useAppStore.getState())
    const stopMirror = useAppStore.subscribe((state, previous) => {
      if (
        state.gitStatusByWorktree !== previous.gitStatusByWorktree ||
        state.activeWorktreeId !== previous.activeWorktreeId
      ) {
        mirrorActiveStatus(state)
      }
    })
    const stopVisibleCards = useWorktreeChangeSummaryStore.subscribe((state, previous) => {
      if (state.visibleWorktrees !== previous.visibleWorktrees) {
        runner.run({ changeSignal: true })
      }
    })
    // Index writes (stage, commit, checkout) arrive attributed per checkout from main's watcher.
    const stopIndexSignal = window.api?.worktrees?.onGitStatusMetadataChanged?.(
      (event: GitStatusMetadataChangedEvent) => {
        const repoPaths = (selectWorktreesByRepo(useAppStore.getState())[event.repoId] ?? []).map(
          (worktree) => worktree.path
        )
        signal(
          (worktree) =>
            worktree.repoId === event.repoId &&
            isGitStatusSignalForWorktree(event, worktree.path, repoPaths)
        )
      }
    )
    const handleCommandFinished = (event: Event): void => {
      const detail: Partial<TerminalCommandFinishedEventDetail> | null =
        event instanceof CustomEvent ? event.detail : null
      const worktreeId = detail?.worktreeId
      if (worktreeId) {
        signal((worktree) => worktree.id === worktreeId)
      }
    }
    window.addEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, handleCommandFinished)
    const stopInterval = installWindowVisibilityInterval({
      run: () => runner.run(),
      runOnVisible: () => runner.run({ changeSignal: true }),
      intervalMs: CHANGE_SUMMARY_TICK_MS
    })

    return () => {
      disposed = true
      controller.abort()
      runner.dispose()
      stopInterval()
      stopMirror()
      stopVisibleCards()
      stopIndexSignal?.()
      window.removeEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, handleCommandFinished)
    }
  }, [active])
}
