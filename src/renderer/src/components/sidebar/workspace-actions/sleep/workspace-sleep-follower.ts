import { useAppStore } from '@/store/index'
import { sleepWorktreeBrowserTabs, wakeWorktreeBrowserTabs } from './browser-tab-sleep'
import {
  captureWorkspaceSelection,
  restoreWorkspaceSelection
} from '@/lib/workspace/ownership/active-workspace-host'
import type { WorkspaceSelection } from '@/lib/workspace/ownership/active-workspace-host'
import {
  clearWorktreeSleepIntent,
  markWorktreeSleepIntent,
  withWorktreeSleepTeardown
} from '@/lib/workspace/sleep/worktree-sleep-intent'
import { preserveSidebarWorktreePosition } from './sleep-worktree-sidebar-position'
import { toastWorkspaceSleepOutcome } from './sleep-worktree-flow'
import type { HostTerminalStop } from '@/store/terminals/terminal-actions'
import type { WorkspaceSleepNotice } from '../../../../../../shared/workspace/lifecycle/workspace-sleep'
import {
  beginCloudFollowedSleep,
  endCloudFollowedSleep,
  isReopenedAfterSleep,
  markWorktreeSuspendCommitted,
  settleCloudFollowedSleep,
  watchReopenDuringSleep
} from './workspace-sleep-follower-cloud'

export { keepWorkspaceAwakeDuringSleep } from './workspace-sleep-follower-cloud'

type FollowedSleep = {
  settle: (stop: HostTerminalStop) => void
  stopWatchingReopen: () => void
  teardown: Promise<Error | null>
  /** The selection to put back if the sleep fails and the user picked nothing meanwhile. */
  selectionBeforeSleep: WorkspaceSelection | null
  /** It stayed selected, read-only, instead of leaving for Home. */
  stayed: boolean
}

const followed = new Map<string, FollowedSleep>()

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
  if (notice.phase === 'suspending') {
    markWorktreeSuspendCommitted(worktreeId)
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
    const { kept, stayed } = beginCloudFollowedSleep(worktreeId, wasActive, notice)
    if (wasActive && !stayed) {
      const restoreSidebarPosition = preserveSidebarWorktreePosition(worktreeId)
      state.setActiveWorktree(null)
      restoreSidebarPosition()
    }
    if (!options.keepBrowserTabs) {
      // Sleep never changes the tab layout: the tabs, their order and the active one stay;
      // only their pages are dropped, and each reloads in place when shown after the wake.
      sleepWorktreeBrowserTabs(worktreeId)
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
      stayed,
      stopWatchingReopen: watchReopenDuringSleep(worktreeId, kept)
    })
    return
  }
  const entry = followed.get(worktreeId)
  followed.delete(worktreeId)
  entry?.stopWatchingReopen()
  const cloudEnd = endCloudFollowedSleep(worktreeId, notice.slept)
  entry?.settle(
    notice.slept
      ? { failed: false, records: notice.records }
      : { failed: true, stoppedPtyIds: notice.stoppedPtyIds ?? [] }
  )
  return (entry?.teardown ?? Promise.resolve(null)).then((error) => {
    const state = useAppStore.getState()
    const reopened = isReopenedAfterSleep(worktreeId, state.activeWorktreeId)
    // A failed sleep leaves the workspace awake and retryable; one the user reopened is theirs.
    if (!notice.slept || reopened) {
      clearWorktreeSleepIntent(worktreeId)
      // Still awake: its tabs count as activity again.
      wakeWorktreeBrowserTabs(worktreeId)
    }
    // Put the awake workspace back after a failed sleep, or one kept on screen and reopened.
    // One the user left is not pulled back.
    const stillShown = state.activeWorktreeId === worktreeId
    if (
      !settleCloudFollowedSleep(worktreeId, cloudEnd, notice.slept, stillShown) &&
      (!notice.slept || (entry?.stayed && reopened)) &&
      entry?.selectionBeforeSleep &&
      (entry.stayed ? stillShown : state.activeWorktreeId === null)
    ) {
      restoreWorkspaceSelection(state, entry.selectionBeforeSleep)
    }
    if (error && options.reportTeardownFailure) {
      throw error
    }
  })
}
