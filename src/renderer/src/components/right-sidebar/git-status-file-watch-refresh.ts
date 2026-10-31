import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { shouldPollActiveGitStatus } from '@/lib/passive-macos-app-data-access'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import type {
  ActiveRightSidebarTab,
  RightSidebarExplorerView
} from '../../../../shared/ui-chrome-types'
import type { OpenFile } from '@/store/slices/editor'
import {
  ORCA_WORKTREE_FILE_CHANGE_EVENT,
  type WorktreeFileChangeEventDetail
} from '@/hooks/worktree-file-change-event'
import { buildIgnoredSet, isPathIgnored } from './status-display'

const WATCH_REFRESH_DEBOUNCE_MS = 125

type UseGitStatusFileWatchRefreshParams = {
  activeConnectionId: string | null
  activeRepoSupportsGit: boolean
  activeWorktreeId: string | null
  enabled: boolean
  fetchStatus: () => void
  gitStatusHugeByWorktree: Record<string, unknown> | undefined
  isConnectionReady: (connectionId: string | null | undefined) => boolean
  openFiles: OpenFile[]
  rightSidebarExplorerView?: RightSidebarExplorerView
  rightSidebarOpen: boolean
  rightSidebarTab: ActiveRightSidebarTab
  worktreePath: string | null
}

export function shouldRefreshGitStatusForFileChange(
  payload: FsChangedPayload,
  worktreePath: string,
  ignoredPaths?: readonly string[]
): boolean {
  if (
    normalizeRuntimePathForComparison(payload.worktreePath) !==
    normalizeRuntimePathForComparison(worktreePath)
  ) {
    return false
  }

  // Why: `git status` without --ignored cannot change for gitignored paths, so build churn there is pure overhead (#30500).
  const ignored = buildIgnoredSet(ignoredPaths)
  const canAffectStatus = (absolutePath: string): boolean => {
    const relativePath = relativePathInsideRoot(worktreePath, absolutePath)
    if (relativePath === null) {
      return false
    }
    return relativePath.split('/').pop() === '.gitignore' || !isPathIgnored(ignored, relativePath)
  }

  return payload.events.some((event) => {
    if (event.kind === 'overflow') {
      return true
    }
    if (event.isDirectory === true) {
      return false
    }
    return (
      canAffectStatus(event.absolutePath) ||
      (event.oldAbsolutePath !== undefined && canAffectStatus(event.oldAbsolutePath))
    )
  })
}

export function useGitStatusFileWatchRefresh({
  activeConnectionId,
  activeRepoSupportsGit,
  activeWorktreeId,
  enabled,
  fetchStatus,
  gitStatusHugeByWorktree,
  isConnectionReady,
  openFiles,
  rightSidebarExplorerView,
  rightSidebarOpen,
  rightSidebarTab,
  worktreePath
}: UseGitStatusFileWatchRefreshParams): void {
  const activeRuntimeEnvironmentId = useAppStore((state) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(state, activeWorktreeId)
  )
  const fetchStatusRef = useRef(fetchStatus)
  fetchStatusRef.current = fetchStatus
  const shouldSubscribe =
    enabled &&
    !!activeWorktreeId &&
    !!worktreePath &&
    activeRepoSupportsGit &&
    shouldPollActiveGitStatus({
      activeWorktreeId,
      worktreePath,
      rightSidebarOpen,
      rightSidebarTab,
      rightSidebarExplorerView,
      openFiles
    }) &&
    isConnectionReady(activeConnectionId) &&
    !gitStatusHugeByWorktree?.[activeWorktreeId]

  useEffect(() => {
    if (!shouldSubscribe || !worktreePath) {
      return
    }

    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleRefresh = (): void => {
      if (!isWindowVisible()) {
        return
      }
      // Nudge once per atomic-write burst; never delay an armed nudge or continuous agent writes could starve refresh.
      if (refreshTimer) {
        return
      }
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        if (!isWindowVisible()) {
          return
        }
        fetchStatusRef.current()
      }, WATCH_REFRESH_DEBOUNCE_MS)
    }
    const handleFsChanged = (event: Event): void => {
      const detail = (event as CustomEvent<WorktreeFileChangeEventDetail>).detail
      if (!detail) {
        return
      }
      if ((detail.runtimeEnvironmentId ?? null) !== (activeRuntimeEnvironmentId ?? null)) {
        return
      }
      const { payload } = detail
      const ignoredPaths = activeWorktreeId
        ? useAppStore.getState().gitIgnoredPathsByWorktree[activeWorktreeId]
        : undefined
      if (shouldRefreshGitStatusForFileChange(payload, worktreePath, ignoredPaths)) {
        scheduleRefresh()
      }
    }
    window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleFsChanged as EventListener)

    return () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer)
      }
      window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleFsChanged as EventListener)
    }
  }, [activeRuntimeEnvironmentId, activeWorktreeId, shouldSubscribe, worktreePath])
}
