import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import {
  beginHugeRepoWarningProbe,
  hasDismissedHugeRepoWarning,
  markHugeRepoWarningDismissed
} from '@/lib/source-control-huge-repo-warning-dismissals'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { translate } from '@/i18n/i18n'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client'
import { useAppStore } from '@/store'
import type { GitPushTarget } from '../../../../../../shared/worktree/types'
import type { PullRequestGenerationContext } from '@/store/slices/pull-request-generation'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'
import {
  ORCA_WORKTREE_FILE_CHANGE_EVENT,
  type WorktreeFileChangeEventDetail
} from '@/hooks/worktree-file-change-event'
import { shouldRefreshGitStatusForFileChange } from '../../git-status-file-watch-refresh'
import { refreshGitStatusForWorktree } from '../../git-status-refresh'

// Why: the global status poller only refreshes the app-active worktree, so a viewed non-active
// worktree needs its own cadence to keep panel state current while it stays pinned.
const VIEWED_WORKTREE_POLL_INTERVAL_MS = 60_000
// Why: file watchers deliver atomic writes as bursts; coalesce them like the app-active lane does.
const VIEWED_WORKTREE_SIGNAL_DEBOUNCE_MS = 125

export type SourceControlStatusRefresh = {
  refreshActiveGitStatus: (signal?: AbortSignal) => Promise<void>
  refreshActiveGitStatusAfterMutation: () => Promise<void>
  refreshGitStatusAfterPullRequestGeneration: (
    context: PullRequestGenerationContext
  ) => Promise<void>
}

export function useSourceControlStatusRefresh({
  activeRepoSettings,
  activeWorktreeId,
  worktreePath,
  activePushTarget,
  isFolder,
  repositoryHuge,
  activeConnectionId,
  activeWorktreeInstanceId,
  worktreeMap
}: {
  activeRepoSettings: RuntimeGitContext['settings']
  activeWorktreeId: string | null
  worktreePath: string | null
  activePushTarget?: GitPushTarget
  isFolder: boolean
  repositoryHuge: { limit: number } | null | undefined
  activeConnectionId: string | null
  activeWorktreeInstanceId?: string
  worktreeMap: ReadonlyMap<string, { pushTarget?: GitPushTarget }>
}): SourceControlStatusRefresh {
  const setGitStatus = useAppStore((s) => s.setGitStatus)
  const updateWorktreeGitIdentity = useAppStore((s) => s.updateWorktreeGitIdentity)
  const setUpstreamStatus = useAppStore((s) => s.setUpstreamStatus)
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  const appActiveWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const viewedWorktreeRuntimeEnvironmentId = useAppStore((s) =>
    getRuntimeEnvironmentIdForWorktree(s, activeWorktreeId)
  )
  const refreshActiveGitStatus = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!activeWorktreeId || !worktreePath || isFolder) {
        return
      }
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      await refreshGitStatusForWorktree({
        // Why: route git status by the repo OWNER host, not the focused runtime.
        settings: activeRepoSettings,
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
        request: { admissionTier: 'interactive', ...(signal ? { signal } : {}) }
      })
    },
    [
      activeRepoSettings,
      activeWorktreeId,
      activePushTarget,
      fetchUpstreamStatus,
      isFolder,
      setGitStatus,
      setUpstreamStatus,
      updateWorktreeGitIdentity,
      worktreePath
    ]
  )
  const refreshActiveGitStatusAfterMutation = useCallback(async (): Promise<void> => {
    try {
      await refreshActiveGitStatus()
    } catch (error) {
      console.warn('[SourceControl] post-mutation git status refresh failed', error)
    }
  }, [refreshActiveGitStatus])

  // Why: the global status poller only refreshes the app-active worktree; a viewed non-active
  // worktree keeps its own cadence so its panel state stays current while it is pinned.
  useEffect(() => {
    if (
      !activeWorktreeId ||
      !worktreePath ||
      isFolder ||
      activeWorktreeId === appActiveWorktreeId
    ) {
      return
    }
    void refreshActiveGitStatus()

    let intervalId: number | null = null
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleRefresh = (): void => {
      if (!isWindowVisible()) {
        return
      }
      if (refreshTimer) {
        clearTimeout(refreshTimer)
      }
      // Why: file watchers deliver atomic writes as bursts; coalesce them like the app-active lane does.
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        if (!isWindowVisible()) {
          return
        }
        void refreshActiveGitStatus()
      }, VIEWED_WORKTREE_SIGNAL_DEBOUNCE_MS)
    }

    intervalId = window.setInterval(() => {
      if (isWindowVisible()) {
        void refreshActiveGitStatus()
      }
    }, VIEWED_WORKTREE_POLL_INTERVAL_MS)

    const handleCommandFinished = (event: Event): void => {
      const detail = (event as CustomEvent<TerminalCommandFinishedEventDetail>).detail
      if (detail?.worktreeId !== activeWorktreeId) {
        return
      }
      scheduleRefresh()
    }
    window.addEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, handleCommandFinished)

    const handleWorktreeFileChange = (event: Event): void => {
      const detail = (event as CustomEvent<WorktreeFileChangeEventDetail>).detail
      if (!detail) {
        return
      }
      if (
        (detail.runtimeEnvironmentId ?? null) !== (viewedWorktreeRuntimeEnvironmentId ?? null)
      ) {
        return
      }
      if (shouldRefreshGitStatusForFileChange(detail.payload, worktreePath)) {
        scheduleRefresh()
      }
    }
    window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleWorktreeFileChange)

    return () => {
      if (intervalId) {
        window.clearInterval(intervalId)
      }
      if (refreshTimer) {
        clearTimeout(refreshTimer)
      }
      window.removeEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, handleCommandFinished)
      window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleWorktreeFileChange)
    }
  }, [
    activeWorktreeId,
    appActiveWorktreeId,
    isFolder,
    refreshActiveGitStatus,
    viewedWorktreeRuntimeEnvironmentId,
    worktreePath
  ])

  // Why: when status is truncated, offer once per worktree to .gitignore the flooding folder; local-only since the SSH huge-folder write path isn't wired.
  useEffect(() => {
    if (!repositoryHuge || !activeWorktreeId || !worktreePath || activeConnectionId) {
      return
    }
    const warningProbe = beginHugeRepoWarningProbe({
      id: activeWorktreeId,
      instanceId: activeWorktreeInstanceId
    })
    if (hasDismissedHugeRepoWarning(warningProbe)) {
      return
    }
    let cancelled = false
    void window.api.git
      .findHugeFoldersToIgnore({ worktreePath })
      .then((folders) => {
        if (cancelled || folders.length === 0 || hasDismissedHugeRepoWarning(warningProbe)) {
          return
        }
        if (!markHugeRepoWarningDismissed(warningProbe)) {
          return
        }
        const folderName = folders[0]
        toast.warning(
          translate(
            'auto.components.right.sidebar.SourceControl.hugeRepoIgnorePrompt',
            'This repository has too many active changes. Add "{{value0}}" to .gitignore?',
            { value0: folderName }
          ),
          {
            action: {
              label: translate(
                'auto.components.right.sidebar.SourceControl.hugeRepoIgnoreAction',
                'Add to .gitignore'
              ),
              onClick: () => {
                // Why: the toast can outlive its worktree; a purged probe must not write .gitignore in a same-path replacement.
                if (!hasDismissedHugeRepoWarning(warningProbe)) {
                  return
                }
                void window.api.git
                  .appendGitignore({ worktreePath, folderName })
                  .then(() => refreshActiveGitStatus())
                  .catch((error) => console.warn('[SourceControl] add to .gitignore failed', error))
              }
            }
          }
        )
      })
      .catch((error) => console.warn('[SourceControl] findHugeFoldersToIgnore failed', error))
    return () => {
      cancelled = true
    }
  }, [
    repositoryHuge,
    activeWorktreeId,
    activeWorktreeInstanceId,
    worktreePath,
    activeConnectionId,
    refreshActiveGitStatus
  ])

  const refreshGitStatusAfterPullRequestGeneration = useCallback(
    async (context: PullRequestGenerationContext): Promise<void> => {
      if (!context.worktreeId || isFolder) {
        return
      }
      try {
        await refreshGitStatusForWorktree({
          // Why: generation can finish after a host switch; refresh the host that owned the generation request.
          settings: context.runtimeTargetSettings,
          worktreeId: context.worktreeId,
          worktreePath: context.worktreePath,
          connectionId: context.connectionId,
          pushTarget: worktreeMap.get(context.worktreeId)?.pushTarget,
          deps: {
            setGitStatus,
            updateWorktreeGitIdentity,
            setUpstreamStatus,
            fetchUpstreamStatus
          }
        })
      } catch (error) {
        console.warn('[SourceControl] post-generation git status refresh failed', error)
      }
    },
    [
      fetchUpstreamStatus,
      isFolder,
      setGitStatus,
      setUpstreamStatus,
      updateWorktreeGitIdentity,
      worktreeMap
    ]
  )

  return {
    refreshActiveGitStatus,
    refreshActiveGitStatusAfterMutation,
    refreshGitStatusAfterPullRequestGeneration
  }
}
