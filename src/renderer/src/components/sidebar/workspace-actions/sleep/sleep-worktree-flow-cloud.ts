// Orca Cloud steps of the window's Sleep, kept out of the upstream sleep flow.
import { toastCloudSleepFailure } from '@/lib/orca-cloud/cloud-sleep-failure-toast'
import {
  isPairedCloudSleepTarget,
  sleepPairedCloudSandboxes
} from '@/lib/orca-cloud/paired-cloud-sleep'
import { isPairedCloudWorkspace } from '@/lib/orca-cloud/paired-cloud-wake'
import { toastPairedSleepRefused } from '@/lib/orca-cloud/paired-sleep-refused-toast'
import type { WorkspaceSleepOutcome } from '../../../../../../shared/workspace/lifecycle/workspace-sleep'
import { dismissOrcaCloudRestartWarning } from '@/lib/orca-cloud-session-toasts'
import { notePredictiveWakeSlept } from '@/lib/orca-cloud/cloud-predictive-wake'
import {
  clearDeliberateCloudStop,
  clearSleepCopySave,
  clearWorktreeGoingToSleep,
  clearWorktreeKeptAwake,
  markSleepCopySaving,
  markWorktreeGoingToSleep,
  noteDeliberateCloudStop,
  releaseWorktreeSleepView
} from '@/lib/worktree-sleep-view'
import { getCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { holdActiveCloudSleepView } from './workspace-sleep-view-hold'
import type { WorktreeSleepOutcome } from './sleep-worktree-flow'

/** Before the host sleep: marks the views the press puts in place. */
export function beginCloudSleep(worktreeIds: readonly string[]): void {
  // Intent (hover, focus) must not wake what was just put to sleep.
  const pressedAt = Date.now()
  const ownedCloud = getCloudWorkspaceSnapshot().ids
  for (const id of worktreeIds) {
    if (ownedCloud.has(id) || isPairedCloudWorkspace(id)) {
      // Saving its read-only copy until the asleep view reads one back; a
      // PAIRED one's is the sealed snapshot its sandbox hands the control plane as it sleeps.
      markSleepCopySaving(id, pressedAt)
      // Its terminals drop on purpose: no "Reattaching terminal" until it's asleep.
      noteDeliberateCloudStop(id, pressedAt)
    }
    notePredictiveWakeSlept(id)
    // "Going to sleep…" from the click on: main first saves the copy the asleep view shows.
    markWorktreeGoingToSleep(id)
    holdActiveCloudSleepView(id)
  }
}

/**
 * After the host sleep: sleeps paired sandboxes through the control plane and shows cloud toasts.
 * Returns whether the generic "machine still running" sleep toast should still show.
 */
export async function finishCloudSleep(
  worktreeIds: readonly string[],
  outcome: Pick<WorktreeSleepOutcome, 'results' | 'vmStillRunningIds' | 'unsleptWorktreeIds'>,
  retry: (ids: readonly string[]) => void
): Promise<boolean> {
  const { results, vmStillRunningIds, unsleptWorktreeIds } = outcome
  // A paired workspace is still going to sleep until its sandbox has slept
  // through the control plane below and its status says so (it has no local record that flips).
  const pairedIds = new Set(worktreeIds.filter((id) => isPairedCloudWorkspace(id)))
  for (const id of worktreeIds) {
    if (!pairedIds.has(id)) {
      clearWorktreeGoingToSleep(id)
    }
    clearWorktreeKeptAwake(id)
  }
  // Refused before main started it (nothing stopped) or failed: the workspace is awake.
  for (const id of unsleptWorktreeIds) {
    releaseWorktreeSleepView(id)
  }
  // Awake after all (refused, or its machine kept running): no copy is coming, and a dropped
  // connection is a real one again.
  for (const id of [...unsleptWorktreeIds, ...vmStillRunningIds]) {
    clearSleepCopySave(id)
    clearDeliberateCloudStop(id)
  }
  // A paired cloud workspace's sandbox sleeps through the control plane.
  const unslept = new Set(unsleptWorktreeIds)
  const { stillRunning: pairedStillRunning, refused: pairedRefused } =
    await sleepPairedCloudSandboxes(worktreeIds.filter((id) => !unslept.has(id))).finally(() => {
      for (const id of pairedIds) {
        clearWorktreeGoingToSleep(id)
      }
    })
  // A member can't sleep a teammate's workspace: that says so, not "still running, try again".
  toastPairedSleepRefused(pairedRefused)
  const refusedIds = new Set(pairedRefused)
  const stillRunningIds = [
    ...vmStillRunningIds,
    ...pairedStillRunning.filter((id) => !refusedIds.has(id))
  ]
  // The paired sandbox kept running: no sealed copy is coming either.
  for (const id of pairedStillRunning) {
    clearSleepCopySave(id)
    clearDeliberateCloudStop(id)
  }
  // An Orca Cloud sandbox left running gets the cloud copy (sandbox hours, Try again) instead.
  const cloudToasted = toastCloudSleepFailure(stillRunningIds, retry)
  // A slept Orca Cloud sandbox won't restart, so its restart warning no longer applies.
  for (const result of results) {
    if (result.completed) {
      dismissOrcaCloudRestartWarning(result.workspaceId)
    }
  }
  return stillRunningIds.length > 0 && !cloudToasted
}

/** How long a PAIRED workspace's host-side Sleep may take before it is left behind. */
export const PAIRED_HOST_SLEEP_TIMEOUT_MS = 30_000

/**
 * A paired workspace's host-side Sleep (its terminals, over the paired connection) can hang when that
 * connection is slow or reconnecting; then neither the control-plane suspend (what stops billing) nor
 * an Archive waiting on this Sleep ever ran. With a paired target in the batch, the host step
 * is bounded: past the timeout a paired target gets no outcome (its sandbox is still put to sleep by
 * the control plane next), and any other target reports the timeout as a failure.
 */
export async function boundPairedHostSleep(
  targets: readonly { worktreeId: string }[],
  call: Promise<WorkspaceSleepOutcome[]>
): Promise<WorkspaceSleepOutcome[]> {
  const worktreeIds = targets.map(({ worktreeId }) => worktreeId)
  if (!worktreeIds.some((id) => isPairedCloudSleepTarget(id))) {
    return call
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PAIRED_HOST_SLEEP_TIMEOUT_MS)
  })
  const outcome = await Promise.race([call, timedOut])
  clearTimeout(timer)
  if (outcome) {
    return outcome
  }
  console.error(
    '[sleep-worktree] host-side sleep timed out; paired sandboxes sleep via the control plane'
  )
  return worktreeIds
    .filter((id) => !isPairedCloudSleepTarget(id))
    .map((worktreeId) => ({
      worktreeId,
      failure: 'The host did not finish putting this workspace to sleep in time.',
      chatFailed: false,
      receipts: []
    }))
}
