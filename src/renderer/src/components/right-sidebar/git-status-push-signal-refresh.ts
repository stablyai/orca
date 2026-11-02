import { useEffect, useRef } from 'react'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'
import type { GitStatusMetadataChangedEvent } from '../../../../shared/worktree/types'
import { isGitStatusSignalForWorktree } from './git-status-signal-attribution'

type UseGitStatusPushSignalRefreshParams = {
  activeRepoId: string | null
  activeWorktreeId: string | null
  activeWorktreePath: string | null
  enabled: boolean
  fetchStatus: () => void
  /** Keep stable: it re-subscribes the push signals when it changes. */
  getRepoWorktreePaths: (repoId: string) => readonly string[]
}

// Push signals beat slow fallback polling after shell mutations; watcher debounce and coalesced pacing absorb bursts.
export function useGitStatusPushSignalRefresh({
  activeRepoId,
  activeWorktreeId,
  activeWorktreePath,
  enabled,
  fetchStatus,
  getRepoWorktreePaths
}: UseGitStatusPushSignalRefreshParams): void {
  const fetchStatusRef = useRef(fetchStatus)
  fetchStatusRef.current = fetchStatus

  useEffect(() => {
    if (!enabled || !activeRepoId) {
      return
    }
    // Remote web has no preload bridge; fallback polling still covers it.
    const subscribeToWorktreesChanged = window.api?.worktrees?.onChanged
    const subscribeToGitStatusMetadataChanged = window.api?.worktrees?.onGitStatusMetadataChanged
    if (!subscribeToWorktreesChanged && !subscribeToGitStatusMetadataChanged) {
      return
    }
    const handleRepoSignal = ({ repoId }: { repoId: string }): void => {
      if (repoId !== activeRepoId || !isWindowVisible()) {
        return
      }
      fetchStatusRef.current()
    }
    // Ignore sibling-worktree index churn that cannot affect this checkout.
    const handleGitStatusSignal = (signal: GitStatusMetadataChangedEvent): void => {
      const paths = getRepoWorktreePaths(signal.repoId)
      if (isGitStatusSignalForWorktree(signal, activeWorktreePath, paths)) {
        handleRepoSignal(signal)
      }
    }
    // Skip hidden-window nudges; visibility polling catches up on reveal.
    const unsubs = [
      subscribeToWorktreesChanged?.(handleRepoSignal),
      subscribeToGitStatusMetadataChanged?.(handleGitStatusSignal)
    ].filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === 'function')
    return () => {
      for (const unsubscribe of unsubs) {
        unsubscribe()
      }
    }
  }, [enabled, activeRepoId, activeWorktreePath, getRepoWorktreePaths])

  useEffect(() => {
    if (!enabled || !activeWorktreeId) {
      return
    }
    const handleCommandFinished = (event: Event): void => {
      const detail = (event as CustomEvent<TerminalCommandFinishedEventDetail>).detail
      if (detail?.worktreeId !== activeWorktreeId || !isWindowVisible()) {
        return
      }
      fetchStatusRef.current()
    }
    window.addEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, handleCommandFinished)
    return () => {
      window.removeEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, handleCommandFinished)
    }
  }, [enabled, activeWorktreeId])
}
