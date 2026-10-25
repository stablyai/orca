import { useAppStore } from '@/store'
import {
  captureWorkspaceSelection,
  restoreWorkspaceSelection,
  type WorkspaceSelection
} from '@/lib/active-workspace-host'
import {
  clearWorktreeSleepIntent,
  markWorktreeSleepIntent,
  withWorktreeSleepTeardown
} from '@/lib/worktree-sleep-intent'
import type { HostTerminalStop } from '@/store/terminals/terminal-actions'
import type { WorkspaceSleepNotice } from '../../../../shared/workspace-sleep'
import { preserveSidebarWorktreePosition } from './sleep-worktree-sidebar-position'
import { toastWorkspaceSleepOutcome } from './sleep-worktree-flow'

type FollowedSleep = {
  settle: (stop: HostTerminalStop) => void
  stopWatchingReopen: () => void
  teardown: Promise<Error | null>
  /** The selection to put back if the sleep fails and the user picked nothing meanwhile. */
  selectionBeforeSleep: WorkspaceSelection | null
}

const followed = new Map<string, FollowedSleep>()

/** Tells main once if the user opens the workspace before its sleep ends: its VM then keeps running. */
function watchReopenDuringSleep(worktreeId: string): () => void {
  const unsubscribe = useAppStore.subscribe((state) => {
    if (state.activeWorktreeId === worktreeId) {
      unsubscribe()
      // Best effort: a missed note only suspends a VM the user can resume.
      void Promise.resolve()
        .then(() => window.api.worktrees.sleepReopened(worktreeId))
        .catch(() => {})
    }
  })
  return unsubscribe
}

/** On main’s started notice, guard panes before exits; on ended, commit teardown or restore failed sleeps. */
export function followWorkspaceSleep(
  notice: WorkspaceSleepNotice,
  options: { keepBrowserTabs?: boolean; reportTeardownFailure?: boolean } = {}
): Promise<void> | void {
  const { worktreeId } = notice
  if (notice.phase === 'failed') {
    toastWorkspaceSleepOutcome(notice.outcome)
    return
  }
  if (notice.phase === 'started') {
    const previous = followed.get(worktreeId)
    previous?.stopWatchingReopen()
    previous?.settle({ failed: true, stoppedPtyIds: [] })
    const state = useAppStore.getState()
    const wasActive = state.activeWorktreeId === worktreeId
    const selectionBeforeSleep = wasActive ? captureWorkspaceSelection(state) : null
    // Why first: clearing the active workspace unmounts its panes, whose exits must not stamp activity.
    markWorktreeSleepIntent(worktreeId)
    if (wasActive) {
      const restoreSidebarPosition = preserveSidebarWorktreePosition(worktreeId)
      state.setActiveWorktree(null)
      restoreSidebarPosition()
    }
    if (!options.keepBrowserTabs) {
      state.shutdownWorktreeBrowsers(worktreeId)
    }
    let settle!: (stop: HostTerminalStop) => void
    const hostStop = new Promise<HostTerminalStop>((resolve) => (settle = resolve))
    const teardown = withWorktreeSleepTeardown(worktreeId, () =>
      useAppStore.getState().shutdownWorktreeTerminals(worktreeId, {
        keepIdentifiers: true,
        hostStop
      })
    ).then(
      () => null,
      (error: unknown) => {
        console.warn('[sleep-worktree] panes kept awake', { worktreeId, error })
        return error instanceof Error ? error : new Error(String(error))
      }
    )
    followed.set(worktreeId, {
      settle,
      teardown,
      selectionBeforeSleep,
      stopWatchingReopen: watchReopenDuringSleep(worktreeId)
    })
    return
  }
  const entry = followed.get(worktreeId)
  followed.delete(worktreeId)
  entry?.stopWatchingReopen()
  entry?.settle(
    notice.slept
      ? { failed: false, records: notice.records }
      : { failed: true, stoppedPtyIds: notice.stoppedPtyIds ?? [] }
  )
  return (entry?.teardown ?? Promise.resolve(null)).then((error) => {
    const state = useAppStore.getState()
    // A failed sleep leaves the workspace awake and retryable; one the user reopened is theirs.
    if (!notice.slept || state.activeWorktreeId === worktreeId) {
      clearWorktreeSleepIntent(worktreeId)
    }
    if (!notice.slept && entry?.selectionBeforeSleep && state.activeWorktreeId === null) {
      restoreWorkspaceSelection(state, entry.selectionBeforeSleep)
    }
    if (error && options.reportTeardownFailure) {
      throw error
    }
  })
}
