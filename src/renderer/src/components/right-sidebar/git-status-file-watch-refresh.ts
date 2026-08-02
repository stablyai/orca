import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { shouldPollActiveGitStatus } from '@/lib/passive-macos-app-data-access'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'
import type {
  ActiveRightSidebarTab,
  FsChangedPayload,
  RightSidebarExplorerView
} from '../../../../shared/types'
import type { OpenFile } from '@/store/slices/editor'
import {
  ORCA_WORKTREE_FILE_CHANGE_EVENT,
  type WorktreeFileChangeEventDetail
} from '@/hooks/worktree-file-change-event'

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
  worktreePath: string
): boolean {
  if (
    normalizeRuntimePathForComparison(payload.worktreePath) !==
    normalizeRuntimePathForComparison(worktreePath)
  ) {
    return false
  }

  return payload.events.some((event) => {
    if (event.kind === 'overflow') {
      return true
    }
    if (event.isDirectory === true) {
      return false
    }
    return relativePathInsideRoot(worktreePath, event.absolutePath) !== null
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
    getRuntimeEnvironmentIdForWorktree(state, activeWorktreeId)
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
      if (refreshTimer) {
        clearTimeout(refreshTimer)
      }
      // Why: file watchers deliver atomic writes as bursts, but git status is
      // already coalesced and should only be nudged once per burst.
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
      if (shouldRefreshGitStatusForFileChange(payload, worktreePath)) {
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
  }, [activeRuntimeEnvironmentId, shouldSubscribe, worktreePath])
}
