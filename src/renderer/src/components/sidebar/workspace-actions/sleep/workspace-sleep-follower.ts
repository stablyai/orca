import { useAppStore } from '@/store'
import { sleepWorktreeBrowserTabs, wakeWorktreeBrowserTabs } from './browser-tab-sleep'
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
  clearWorktreeKeptAwake,
  clearWorktreeSuspendCommitted,
  isWorktreeKeptAwake,
  markWorktreeSuspendCommitted,
  isWorktreeSleepViewHeld,
  markWorktreeKeptAwake,
  markWorktreeGoingToSleep,
  releaseWorktreeSleepView,
  subscribeWorktreeSleepView
} from '@/lib/worktree-sleep-view'
import { notePredictiveWakeSlept } from '@/lib/orca-cloud/cloud-predictive-wake'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
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

function noteReopened(worktreeId: string): void {
  // Best effort: a missed note only suspends a VM the user can resume.
  void Promise.resolve()
    .then(() => window.api.worktrees.sleepReopened(worktreeId))
    .catch(() => {})
}

/**
 * "Keep awake" in the view kept on screen after Sleep: the same as opening the workspace before
 * the sleep ends. Main keeps its VM running; the workspace stays selected and becomes awake again.
 */
export function keepWorkspaceAwakeDuringSleep(worktreeId: string): void {
  markWorktreeKeptAwake(worktreeId)
  // Told here, once: the reopen watcher must not tell main again when the hold ends.
  followed.get(worktreeId)?.stopWatchingReopen()
  clearWorktreeGoingToSleep(worktreeId)
  releaseWorktreeSleepView(worktreeId)
  noteReopened(worktreeId)
}

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
      noteReopened(worktreeId)
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
    // Why first: clearing the active workspace unmounts its panes, and a kept one's panes lose
    // their PTYs; either way their exits must not stamp activity.
    markWorktreeSleepIntent(worktreeId)
    // Kept awake before main started: it stays selected and awake, and main was already told.
    const kept = wasActive && isWorktreeKeptAwake(worktreeId)
    if (!kept) {
      markWorktreeGoingToSleep(worktreeId)
    }
    // A project move pauses through sleep and still leaves; an Orca Cloud workspace the user put
    // to sleep stays on screen read-only.
    const stayed =
      kept || (wasActive && !notice.projectMovePauseId && holdActiveCloudSleepView(worktreeId))
    if (kept) {
      // Main reads its reopen baseline when the sleep starts (after it saved the copy): a Keep awake
      // pressed before that is told again now, or the VM is still suspended.
      noteReopened(worktreeId)
    } else if (stayed) {
      // Window focus on the workspace still on screen must not wake it (phone or CLI sleeps too).
      notePredictiveWakeSlept(worktreeId)
    } else if (wasActive) {
      const restoreSidebarPosition = preserveSidebarWorktreePosition(worktreeId)
      state.setActiveWorktree(null)
      restoreSidebarPosition()
    }
    if (!options.keepBrowserTabs) {
      // Sleep never changes the tab layout (NEW-01): the tabs, their order and the active one stay;
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
      stopWatchingReopen: kept ? () => {} : watchReopenDuringSleep(worktreeId)
    })
    return
  }
  const entry = followed.get(worktreeId)
  followed.delete(worktreeId)
  entry?.stopWatchingReopen()
  const keptAwake = isWorktreeKeptAwake(worktreeId)
  clearWorktreeKeptAwake(worktreeId)
  clearWorktreeSuspendCommitted(worktreeId)
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
      // Still awake: its tabs count as activity again.
      wakeWorktreeBrowserTabs(worktreeId)
    }
    // Put the awake workspace back after a failed sleep, or one kept awake from the view:
    // re-activating it in place respawns its stopped panes. One the user left is not pulled back.
    if (keptAwake && notice.slept && state.activeWorktreeId === worktreeId) {
      // Keep awake can land after main already began suspending (it checks just before): open it
      // the ordinary way, which re-activates it and wakes the sandbox only if it did go to sleep.
      void activateWorktreeFromSidebar(worktreeId)
    } else if ((!notice.slept || (entry?.stayed && reopened)) && entry?.selectionBeforeSleep) {
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
