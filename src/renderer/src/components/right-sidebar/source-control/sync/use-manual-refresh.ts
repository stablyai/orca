import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  applyManualSourceControlDiffReload,
  shouldStartManualSourceControlRefresh
} from '../../source-control-manual-refresh'

type ManualRefreshArgs = {
  activeWorktreeId: string | null | undefined
  worktreePath: string | null | undefined
  isFolder: boolean
  refreshActiveGitStatus: (signal?: AbortSignal) => Promise<void>
  refreshBranchCompare: () => Promise<void>
  refreshGitHistory: () => Promise<void>
}

/** Re-read status and force open staged/unstaged diffs to refetch even when porcelain is unchanged. */
export function useSourceControlManualRefresh({
  activeWorktreeId,
  worktreePath,
  isFolder,
  refreshActiveGitStatus,
  refreshBranchCompare,
  refreshGitHistory
}: ManualRefreshArgs): {
  onManualRefresh: () => Promise<void>
  isManualRefreshing: boolean
} {
  const [isManualRefreshing, setIsManualRefreshing] = useState(false)
  const inFlightRef = useRef(false)

  const onManualRefresh = useCallback(async (): Promise<void> => {
    if (
      !activeWorktreeId ||
      !worktreePath ||
      isFolder ||
      !shouldStartManualSourceControlRefresh(inFlightRef.current)
    ) {
      return
    }

    inFlightRef.current = true
    setIsManualRefreshing(true)
    try {
      await refreshActiveGitStatus()
      useAppStore.setState((state) => ({
        openFiles: applyManualSourceControlDiffReload(
          state.openFiles,
          activeWorktreeId,
          state.editorViewMode
        )
      }))
      await Promise.all([refreshBranchCompare(), refreshGitHistory()])
    } catch (error) {
      console.warn('[SourceControl] manual refresh failed', error)
    } finally {
      inFlightRef.current = false
      setIsManualRefreshing(false)
    }
  }, [
    activeWorktreeId,
    isFolder,
    refreshActiveGitStatus,
    refreshBranchCompare,
    refreshGitHistory,
    worktreePath
  ])

  return { onManualRefresh, isManualRefreshing }
}
