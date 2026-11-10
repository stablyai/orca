import { useAppStore } from '@/store/index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { useEffect } from 'react'
import { isWindowVisible } from '@/lib/window-activity/window-visibility-interval'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'
import type { GitStatusMetadataChangedEvent } from '../../../../../../shared/worktree/types'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/cross-platform-path'
import { gitStatusSignalRecipientTest } from './git-status-signal-attribution'

type UseGitStatusPushSignalRefreshParams = {
  activeRepoId: string | null
  activeWorktreeId: string | null
  activeWorktreePath: string | null
  enabled: boolean
  /** Keep stable: a change re-registers the observer. */
  fetchStatus: () => void
}

type Observer = {
  repoId: string | null
  worktreeId: string | null
  /** Normalized once at registration so each dispatch is a set lookup. */
  normalizedPath: string | null
  fetchStatus: () => void
}
const observers = new Set<Observer>()

// Fresh membership per signal: the catalog is the only source, so no cache needs invalidating.
function knownRepoWorktreePaths(repoId: string): readonly string[] {
  return (selectWorktreesByRepo(useAppStore.getState())[repoId] ?? []).map(
    (worktree) => worktree.path
  )
}
let disposeSignals: (() => void) | null = null
function subscribeSignals(): () => void {
  const repoSignal = ({ repoId }: { repoId: string }) => {
    if (!isWindowVisible()) {
      return
    }
    for (const observer of observers) {
      if (observer.repoId === repoId) {
        observer.fetchStatus()
      }
    }
  }
  // One catalog read and K + A normalizations per signal, then a set lookup per observer.
  const metadataSignal = (signal: GitStatusMetadataChangedEvent) => {
    if (!isWindowVisible()) {
      return
    }
    const isRecipient = gitStatusSignalRecipientTest(signal, knownRepoWorktreePaths)
    for (const observer of observers) {
      if (observer.repoId === signal.repoId && isRecipient(observer.normalizedPath)) {
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
      if (detail?.worktreeId === observer.worktreeId) {
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
  fetchStatus
}: UseGitStatusPushSignalRefreshParams): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    const observer: Observer = {
      repoId: activeRepoId,
      worktreeId: activeWorktreeId,
      normalizedPath: activeWorktreePath
        ? normalizeRuntimePathForComparison(activeWorktreePath)
        : null,
      fetchStatus
    }
    observers.add(observer)
    if (disposeSignals == null) {
      disposeSignals = subscribeSignals()
    }
    return () => {
      observers.delete(observer)
      if (observers.size === 0) {
        disposeSignals?.()
        disposeSignals = null
      }
    }
  }, [enabled, activeRepoId, activeWorktreeId, activeWorktreePath, fetchStatus])
}
