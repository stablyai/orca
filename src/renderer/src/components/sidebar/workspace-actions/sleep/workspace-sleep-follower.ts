import { useAppStore } from '@/store'
import {
  captureWorkspaceSelection,
  restoreWorkspaceSelection,
  type WorkspaceSelection
} from '@/lib/workspace/ownership/active-workspace-host'
import {
  clearWorktreeSleepIntent,
  markWorktreeSleepIntent,
  withWorktreeSleepTeardown
} from '@/lib/worktree-sleep-intent'
import {
  clearWorktreeGoingToSleep,
  isWorktreeSleepViewHeld,
  markWorktreeGoingToSleep,
  releaseWorktreeSleepView,
  subscribeWorktreeSleepView
} from '@/lib/worktree-sleep-view'
import { notePredictiveWakeSlept } from '@/lib/orca-cloud/cloud-predictive-wake'
import type { HostTerminalStop } from '@/store/terminals/terminal-actions'
import type { WorkspaceSleepNotice } from '../../../../../../shared/workspace-sleep'
import { preserveSidebarWorktreePosition } from './sleep-worktree-sidebar-position'
import { toastWorkspaceSleepOutcome } from './sleep-worktree-flow'
import { holdActiveCloudSleepView } from './workspace-sleep-view-hold'

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

/**
 * Tells main once if the user opens the workspace before its sleep ends: its VM then keeps running.
 * A workspace kept on screen read-only after its Sleep is not opened; leaving it and coming back,
 * or waking it, is.
 */
function watchReopenDuringSleep(worktreeId: string): () => void {
  const check = (): void => {
    if (
      useAppStore.getState().activeWorktreeId === worktreeId &&
      !isWorktreeSleepViewHeld(worktreeId)
    ) {
      stop()
      // Best effort: a missed note only suspends a VM the user can resume.
      void Promise.resolve()
        .then(() => window.api.worktrees.sleepReopened(worktreeId))
        .catch(() => {})
    }
  }
  const offStore = useAppStore.subscribe(check)
  const offView = subscribeWorktreeSleepView(check)
  const stop = (): void => {
    offStore()
    offView()
  }
  return stop
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
    // Why first: clearing the active workspace unmounts its panes, and a kept one's panes lose
    // their PTYs; either way their exits must not stamp activity.
    markWorktreeSleepIntent(worktreeId)
    markWorktreeGoingToSleep(worktreeId)
    // A project move pauses through sleep and still leaves; an Orca Cloud workspace the user put
    // to sleep stays on screen read-only.
    const stayed = wasActive && !notice.projectMovePauseId && holdActiveCloudSleepView(worktreeId)
    if (stayed) {
      // Window focus on the workspace still on screen must not wake it (phone or CLI sleeps too).
      notePredictiveWakeSlept(worktreeId)
    } else if (wasActive) {
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
      stayed,
      stopWatchingReopen: watchReopenDuringSleep(worktreeId)
    })
    return
  }
  const entry = followed.get(worktreeId)
  followed.delete(worktreeId)
  entry?.stopWatchingReopen()
  clearWorktreeGoingToSleep(worktreeId)
  if (!notice.slept) {
    // A failed sleep leaves the workspace awake: nothing is view-only any more.
    releaseWorktreeSleepView(worktreeId)
  }
  entry?.settle(
    notice.slept
      ? { failed: false, records: notice.records }
      : { failed: true, stoppedPtyIds: notice.stoppedPtyIds ?? [] }
  )
  return (entry?.teardown ?? Promise.resolve(null)).then((error) => {
    const state = useAppStore.getState()
    const reopened = state.activeWorktreeId === worktreeId && !isWorktreeSleepViewHeld(worktreeId)
    // A failed sleep leaves the workspace awake and retryable; one the user reopened is theirs.
    if (!notice.slept || reopened) {
      clearWorktreeSleepIntent(worktreeId)
    }
    if (!notice.slept && entry?.selectionBeforeSleep) {
      // Put the awake workspace back: re-activating a kept one respawns its stopped panes. One the
      // user left meanwhile is not pulled back.
      const stillThere = entry.stayed
        ? state.activeWorktreeId === worktreeId
        : state.activeWorktreeId === null
      if (stillThere) {
        restoreWorkspaceSelection(state, entry.selectionBeforeSleep)
      }
    }
    if (error && options.reportTeardownFailure) {
      throw error
    }
  })
}
