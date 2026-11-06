import { useEffect, useRef } from 'react'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'
import type { GitStatusMetadataChangedEvent } from '../../../../../../shared/worktree/types'
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

type Observer = UseGitStatusPushSignalRefreshParams
const observers = new Set<Observer>()
let disposeSignals: (() => void) | null = null
function subscribeSignals(): () => void {
  const repoSignal = ({ repoId }: { repoId: string }) => {
    if (!isWindowVisible()) {
      return
    }
    for (const observer of observers) {
      if (observer.activeRepoId === repoId) {
        observer.fetchStatus()
      }
    }
  }
  const metadataSignal = (signal: GitStatusMetadataChangedEvent) => {
    if (!isWindowVisible()) {
      return
    }
    for (const observer of observers) {
      if (
        observer.activeRepoId === signal.repoId &&
        isGitStatusSignalForWorktree(
          signal,
          observer.activeWorktreePath,
          observer.getRepoWorktreePaths(signal.repoId)
        )
      ) {
        observer.fetchStatus()
      }
    }
  }
  const commandSignal = (event: Event) => {
    if (!isWindowVisible()) {
      return
    }
    const detail = (event as CustomEvent<TerminalCommandFinishedEventDetail>).detail
    for (const observer of observers) {
      if (detail?.worktreeId === observer.activeWorktreeId) {
        observer.fetchStatus()
      }
    }
  }
  const unsubs = [
    window.api?.worktrees?.onChanged?.(repoSignal),
    window.api?.worktrees?.onGitStatusMetadataChanged?.(metadataSignal)
  ]
  window.addEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, commandSignal)
  return () => {
    for (const unsub of unsubs) {
      unsub?.()
    }
    window.removeEventListener(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, commandSignal)
  }
}
export function useGitStatusPushSignalRefresh(params: UseGitStatusPushSignalRefreshParams): void {
  const latest = useRef(params)
  latest.current = params
  const { enabled, activeRepoId, activeWorktreeId, activeWorktreePath, getRepoWorktreePaths } =
    params
  useEffect(() => {
    if (!enabled) {
      return
    }
    const observer = {
      enabled,
      activeRepoId,
      activeWorktreeId,
      activeWorktreePath,
      getRepoWorktreePaths,
      fetchStatus: () => latest.current.fetchStatus()
    }
    observers.add(observer)
    disposeSignals ??= subscribeSignals()
    return () => {
      observers.delete(observer)
      if (observers.size === 0) {
        disposeSignals?.()
        disposeSignals = null
      }
    }
  }, [enabled, activeRepoId, activeWorktreeId, activeWorktreePath, getRepoWorktreePaths])
}
