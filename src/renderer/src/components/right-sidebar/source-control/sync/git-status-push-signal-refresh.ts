import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { useEffect } from 'react'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'
import type { GitStatusMetadataChangedEvent } from '../../../../../../shared/worktree/types'
import { isGitStatusSignalForWorktree } from './git-status-signal-attribution'

export function getRepoWorktreePathsForSignal(repoId: string): readonly string[] {
  return (selectWorktreesByRepo(useAppStore.getState())[repoId] ?? []).map(
    (worktree) => worktree.path
  )
}

type UseGitStatusPushSignalRefreshParams = {
  activeRepoId: string | null
  activeWorktreeId: string | null
  activeWorktreePath: string | null
  enabled: boolean
  fetchStatus: () => void
  /** Keep stable with fetchStatus: either change re-registers the observer. */
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
export function useGitStatusPushSignalRefresh({
  enabled,
  activeRepoId,
  activeWorktreeId,
  activeWorktreePath,
  fetchStatus,
  getRepoWorktreePaths
}: UseGitStatusPushSignalRefreshParams): void {
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
      fetchStatus
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
  }, [
    enabled,
    activeRepoId,
    activeWorktreeId,
    activeWorktreePath,
    fetchStatus,
    getRepoWorktreePaths
  ])
}
