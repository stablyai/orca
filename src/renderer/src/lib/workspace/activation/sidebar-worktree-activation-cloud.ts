// Orca Cloud steps of opening and waking a workspace from the sidebar. The upstream activation
// calls each at one point; local, SSH and per-workspace-VM workspaces pass through untouched.
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { EphemeralVmWorkspaceLifecycleResult } from '../../../../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtimes'
import {
  getCloudWorkspaceSnapshot,
  isCloudWorkspaceArchived,
  noteCloudWakeProgress,
  refreshCloudWorkspaceStatusIfStale,
  refreshCloudWorkspaceStatus
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
import {
  beginWorkspaceWake,
  endWorkspaceWake
} from '@/components/terminal-pane/input/wake-input-buffer'
import { CLOUD_WORKSPACE_ARCHIVED_ERROR } from '../../../../../shared/hosted-sandbox/cloud-workspace-api'
import { isWakeActive } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { claimPredictiveWake } from '@/lib/orca-cloud/cloud-predictive-wake'
import {
  isWorktreeSleepViewHeld,
  isWorktreeSuspendCommitted,
  releaseWorktreeSleepView
} from '@/lib/worktree-sleep-view'
import { requestWakeAfterSleep } from '@/lib/worktree-sleep-wake-request'
import { markWorktreeSleepIntent } from '@/lib/workspace/sleep/worktree-sleep-intent'
import { holdActiveCloudSleepView } from '@/components/sidebar/workspace-actions/sleep/workspace-sleep-view-hold'
import type { EphemeralVmWakeOutcome } from './sidebar-worktree-activation'

/**
 * Before opening a worktree: true when the open is deferred until its VM's sleep ends (the caller
 * then returns). Otherwise releases a read-only after-Sleep view, since opening it wakes it.
 */
export function deferOpenUntilCloudSleepEnds(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): boolean {
  // "Wake to continue", or opening it again from its row, while main is already suspending its VM:
  // the VM must go down before it can wake, so it shows as waking from now and wakes once the
  // sleep ends (the sleep follower does that). Opening it now would show dead panes meanwhile.
  if (isWorktreeSuspendCommitted(worktreeId)) {
    if (!isWorktreeSleepViewHeld(worktreeId)) {
      // Left and come back: select it, then (before its panes mount) keep it asleep and on
      // screen read-only, as when it went to sleep, so its panes wait instead of reattaching.
      activateAndRevealWorktree(worktreeId, {
        navigationIntent: 'user-open',
        revealInSidebar: false,
        ...(executionHostId ? { executionHostId } : {})
      })
      markWorktreeSleepIntent(worktreeId)
      holdActiveCloudSleepView(worktreeId)
    }
    requestWakeAfterSleep(worktreeId, Date.now())
    return true
  }
  // Opening (or "Wake to continue" on) a workspace kept read-only after its Sleep wakes it.
  releaseWorktreeSleepView(worktreeId)
  return false
}

export type CloudResumeStart = { startedAt: number; cloudAsleep: boolean }

/**
 * Runs before the resume IPC, synchronously so the wake still starts first. Returns `outcome` when
 * Orca Cloud settles the wake itself (paired workspace, or archived: never woken).
 */
export function startCloudResume(
  worktreeId: string
): { outcome: EphemeralVmWakeOutcome | Promise<EphemeralVmWakeOutcome> } | CloudResumeStart {
  // Opening takes over a wake started on intent: its progress and any failure now show.
  claimPredictiveWake(worktreeId)
  // A PAIRED cloud workspace has no VM record here: the control plane wakes it.
  if (worktreeId in getCloudWorkspaceSnapshot().paired) {
    return {
      outcome: import('@/lib/orca-cloud/paired-cloud-wake').then(
        ({ wakePairedCloudWorkspaceIfAsleep }) => wakePairedCloudWorkspaceIfAsleep(worktreeId)
      )
    }
  }
  // An archived Orca Cloud workspace opens its read-only archive view; only Unarchive wakes it.
  // A cold start or a stale read must not wake it, so a cloud workspace re-reads its status first.
  const cloud = getCloudWorkspaceSnapshot()
  const maybeCloud = !cloud.idsLoaded || cloud.ids.has(worktreeId)
  // Known archived: never wake. Otherwise don't wait on a status round trip before waking: main
  // and the control plane both refuse to resume an archive, and that refusal shows the archive.
  if (maybeCloud && isCloudWorkspaceArchived(worktreeId)) {
    return { outcome: { ok: true } }
  }
  if (maybeCloud) {
    void refreshCloudWorkspaceStatusIfStale(worktreeId, 30_000)
  }
  // Typing from the click on is accepted and delivered to the woken terminal.
  const startedAt = Date.now()
  const cloudAsleep = cloud.status[worktreeId]?.status?.state === 'sleeping'
  if (cloudAsleep) {
    beginWorkspaceWake(worktreeId, startedAt)
  }
  return { startedAt, cloudAsleep }
}

/** Holds typed input for a waking workspace (cloud or VM) until its resume settles. */
export function holdWakeInputUntilResumed(
  worktreeId: string,
  resume: Promise<EphemeralVmWorkspaceLifecycleResult>,
  { startedAt, cloudAsleep }: CloudResumeStart,
  isVmWorkspace: boolean
): void {
  if (isVmWorkspace) {
    beginWorkspaceWake(worktreeId, startedAt)
  }
  const wakeHeld = cloudAsleep || isVmWorkspace
  void resume
    .then(
      (result) => result,
      () => null
    )
    .then((result) => {
      if (!wakeHeld) {
        return
      }
      // A wake main reports (waking → ready/failed) settles the hold itself; the answer to this
      // call can come before the woken terminal is attached. Settle here only when no wake ran.
      if (getCloudWorkspaceSnapshot().wake[worktreeId]) {
        return
      }
      endWorkspaceWake(worktreeId, result && result.ok !== false ? 'ready' : 'failed')
    })
}

/** A failed resume's outcome when no toast should report it; null lets the caller toast it. */
export function cloudResumeFailureOutcome(
  worktreeId: string,
  result: EphemeralVmWorkspaceLifecycleResult,
  reason: string,
  reportFailure: boolean | undefined
): EphemeralVmWakeOutcome | null {
  if (JSON.stringify(result).includes(CLOUD_WORKSPACE_ARCHIVED_ERROR)) {
    // Archived elsewhere since this window last looked: show the archive instead of failing.
    void refreshCloudWorkspaceStatus(worktreeId)
    return { ok: true }
  }
  if (getCloudWorkspaceSnapshot().ids.has(worktreeId)) {
    // The cloud waking overlay turns into its own failure card; no second toast.
    failCloudWake(worktreeId, reason)
    return { ok: false, reason }
  }
  if (reportFailure === false) {
    return { ok: false, reason }
  }
  return null
}

/** Main reports a step failure itself; this covers failures after the step (re-pairing). */
function failCloudWake(worktreeId: string, message: string): void {
  const wake = getCloudWorkspaceSnapshot().wake[worktreeId]
  if (!wake || !isWakeActive(wake, Date.now())) {
    return
  }
  noteCloudWakeProgress({ ...wake, phase: 'failed', at: Date.now(), message })
}
