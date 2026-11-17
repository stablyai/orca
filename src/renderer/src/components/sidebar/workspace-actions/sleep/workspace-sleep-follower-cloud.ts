// Orca Cloud steps of following main's workspace sleep (kept on screen read-only, Keep awake,
// "Wake to continue"), kept out of the upstream follower.
import { useAppStore } from '@/store/index'
import {
  clearWorktreeGoingToSleep,
  clearWorktreeKeptAwake,
  clearWorktreeSuspendCommitted,
  isWorktreeKeptAwake,
  isWorktreeSleepViewHeld,
  markWorktreeKeptAwake,
  markWorktreeGoingToSleep,
  releaseWorktreeSleepView,
  subscribeWorktreeSleepView
} from '@/lib/worktree-sleep-view'
import { notePredictiveWakeSlept } from '@/lib/orca-cloud/cloud-predictive-wake'
import {
  clearWakeAfterSleepRequest,
  hasWakeAfterSleepRequest,
  noteWakeAfterSleepSleepEnded
} from '@/lib/worktree-sleep-wake-request'
import { endWorkspaceWake } from '@/components/terminal-pane/input/wake-input-buffer'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import { holdActiveCloudSleepView } from './workspace-sleep-view-hold'

export { markWorktreeSuspendCommitted } from '@/lib/worktree-sleep-view'

/** The live reopen watcher of each followed sleep, so Keep awake can stop it. */
const reopenWatchers = new Map<string, () => void>()

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
  reopenWatchers.get(worktreeId)?.()
  clearWorktreeGoingToSleep(worktreeId)
  releaseWorktreeSleepView(worktreeId)
  noteReopened(worktreeId)
}

/**
 * Tells main once if the user opens the workspace before its sleep ends: its VM then keeps running.
 * A workspace kept on screen read-only after its Sleep is not opened; leaving it and coming back,
 * or waking it, is. One kept awake before main started was already told: nothing to watch.
 */
export function watchReopenDuringSleep(worktreeId: string, kept: boolean): () => void {
  if (kept) {
    return () => {}
  }
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
    if (reopenWatchers.get(worktreeId) === stop) {
      reopenWatchers.delete(worktreeId)
    }
  }
  reopenWatchers.set(worktreeId, stop)
  return stop
}

/**
 * On main's started notice, after the sleep intent is marked. `stayed`: it stays selected
 * (kept awake, or an Orca Cloud workspace the user put to sleep, read-only) instead of leaving.
 */
export function beginCloudFollowedSleep(
  worktreeId: string,
  wasActive: boolean,
  notice: { projectMovePauseId?: string }
): { kept: boolean; stayed: boolean } {
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
  }
  return { kept, stayed }
}

export type CloudSleepEnd = { keptAwake: boolean; wakeRequested: boolean }

/** On main's ended notice, before the host stop settles. */
export function endCloudFollowedSleep(worktreeId: string, slept: boolean): CloudSleepEnd {
  const keptAwake = isWorktreeKeptAwake(worktreeId)
  // "Wake to continue" pressed while main was suspending: the wake starts now the VM is down.
  const wakeRequested = hasWakeAfterSleepRequest(worktreeId)
  if (wakeRequested) {
    noteWakeAfterSleepSleepEnded(worktreeId, Date.now())
  }
  clearWorktreeKeptAwake(worktreeId)
  clearWorktreeSuspendCommitted(worktreeId)
  clearWorktreeGoingToSleep(worktreeId)
  if (!slept) {
    // A failed sleep leaves the workspace awake: nothing is view-only any more.
    releaseWorktreeSleepView(worktreeId)
  }
  return { keptAwake, wakeRequested }
}

/** Opened after the sleep: selected, and not just kept on screen read-only. */
export function isReopenedAfterSleep(worktreeId: string, activeWorktreeId: string | null): boolean {
  return activeWorktreeId === worktreeId && !isWorktreeSleepViewHeld(worktreeId)
}

/**
 * The sleep a "Wake to continue" waited on ended. Still on screen and slept: wake it the ordinary
 * way (its reports take over the waking view, counted from the press). A failed sleep left it
 * awake (held typing goes through); one the user left meanwhile is not woken behind their back.
 */
function finishWakeAfterSleep(worktreeId: string, slept: boolean, stillShown: boolean): void {
  if (slept && stillShown) {
    void activateWorktreeFromSidebar(worktreeId).finally(() =>
      clearWakeAfterSleepRequest(worktreeId)
    )
    return
  }
  clearWakeAfterSleepRequest(worktreeId)
  endWorkspaceWake(worktreeId, slept ? 'failed' : 'ready')
}

/**
 * After the teardown: a "Wake to continue" or a late Keep awake reopens the workspace.
 * True when that took over, so the selection is not also restored.
 */
export function settleCloudFollowedSleep(
  worktreeId: string,
  end: CloudSleepEnd,
  slept: boolean,
  stillShown: boolean
): boolean {
  if (end.wakeRequested) {
    finishWakeAfterSleep(worktreeId, slept, stillShown)
  }
  if (end.wakeRequested && slept) {
    // Woken above (or, left meanwhile, not pulled back); nothing to restore.
    return true
  }
  if (end.keptAwake && slept && stillShown) {
    // Keep awake can land after main already began suspending (it checks just before): open it
    // the ordinary way, which re-activates it and wakes the sandbox only if it did go to sleep.
    void activateWorktreeFromSidebar(worktreeId)
    return true
  }
  return false
}
