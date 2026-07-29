import { useEffect, useRef } from 'react'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'

type UseGitStatusPushSignalRefreshParams = {
  activeRepoId: string | null
  activeWorktreeId: string | null
  enabled: boolean
  fetchStatus: () => void
}

// Why: these push signals close the latency gap left by the slow terminal-only
// fallback poll — branch switches and commits made inside shells surface at
// the coalescer's floor instead of waiting out the fallback cadence. Bursts
// are safe: the main-process watcher debounces and fetchStatus feeds a
// coalesced runner with a minimum interval.
export function useGitStatusPushSignalRefresh({
  activeRepoId,
  activeWorktreeId,
  enabled,
  fetchStatus
}: UseGitStatusPushSignalRefreshParams): void {
  const fetchStatusRef = useRef(fetchStatus)
  fetchStatusRef.current = fetchStatus

  useEffect(() => {
    if (!enabled || !activeRepoId) {
      return
    }
    // Why: remote web surfaces have no preload bridge; the fallback poll
    // still covers them.
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
    // Repo metadata changed on disk. Hidden windows skip the nudge; the
    // visibility interval refreshes immediately on reveal.
    const unsubs = [
      subscribeToWorktreesChanged?.(handleRepoSignal),
      subscribeToGitStatusMetadataChanged?.(handleRepoSignal)
    ].filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === 'function')
    return () => {
      for (const unsubscribe of unsubs) {
        unsubscribe()
      }
    }
  }, [enabled, activeRepoId])

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
