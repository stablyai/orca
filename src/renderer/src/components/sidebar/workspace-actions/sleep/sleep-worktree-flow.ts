import { toast } from 'sonner'
import { toastCloudSleepFailure } from '@/lib/orca-cloud/cloud-sleep-failure-toast'
import {
  isPairedCloudSleepTarget,
  sleepPairedCloudSandboxes
} from '@/lib/orca-cloud/paired-cloud-sleep'
import { isPairedCloudWorkspace } from '@/lib/orca-cloud/paired-cloud-wake'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorkspaceSleepOutcome } from '../../../../../../shared/workspace-sleep'
import { workspaceSleepTarget } from './workspace-sleep-target'
import { dismissOrcaCloudRestartWarning } from '@/lib/orca-cloud-session-toasts'
import { notePredictiveWakeSlept } from '@/lib/orca-cloud/cloud-predictive-wake'
import {
  clearSleepCopySave,
  clearWorktreeGoingToSleep,
  clearWorktreeKeptAwake,
  markSleepCopySaving,
  markWorktreeGoingToSleep,
  releaseWorktreeSleepView
} from '@/lib/worktree-sleep-view'
import { getCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { holdActiveCloudSleepView } from './workspace-sleep-view-hold'

/** One per host asked to stop the workspace's chats. */
export type WorkspaceSleepResult = {
  workspaceId: string
  executionHostId: ExecutionHostId
  stoppedSessionIds: string[]
  /** The whole workspace slept and is still asleep. */
  completed: boolean
}

/** Main sleeps workspace hosts; this window follows notices and reports the outcome for every entrypoint. */
export async function runSleepWorktree(worktreeId: string): Promise<WorkspaceSleepResult[]> {
  return runSleepWorktrees([worktreeId])
}

function describeSleepFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  // Check twin ambiguity before terminal errors because its message also contains terminal_.
  if (detail.includes('ambiguous_terminal_owner')) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.twin.unattributed',
      "Orca couldn't tell which host runs this workspace's terminals, so the workspace was kept open. Reconnect its hosts and try again."
    )
  }
  if (detail.includes('legacy')) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.legacy.unverified',
      'The older host runtime could not confirm terminal shutdown. The workspace was kept open; update the host and try again.'
    )
  }
  if (
    detail.includes('terminal_') ||
    detail.includes('runtime') ||
    detail.includes('connection') ||
    detail.includes('Daemon')
  ) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.host.unverified',
      'The host could not confirm terminal shutdown. The workspace was kept open; check the connection and try again.'
    )
  }
  return translate(
    'auto.components.sidebar.sleep.worktree.flow.retry',
    'The workspace was kept open. Try again; if the problem continues, check the host connection.'
  )
}

function describeVmSuspendFailure(): string {
  return translate(
    'auto.components.sidebar.sleep.worktree.flow.vm.running',
    "The workspace's terminals stopped, but its machine couldn't be suspended and is still running."
  )
}

function describeChatStopFailure(): string {
  return translate(
    'auto.components.sidebar.sleep.worktree.flow.chat.partial',
    'The host could not confirm the chat stopped. Other panels may have closed; check the connection and try again.'
  )
}

export async function runSleepWorktrees(
  worktreeIds: readonly string[]
): Promise<WorkspaceSleepResult[]> {
  // Intent (hover, focus) must not wake what was just put to sleep.
  const pressedAt = Date.now()
  const ownedCloud = getCloudWorkspaceSnapshot().ids
  for (const id of worktreeIds) {
    if (ownedCloud.has(id) || isPairedCloudWorkspace(id)) {
      // Saving its read-only copy until the asleep view reads one back (SLEEP-IN-PROGRESS); a
      // PAIRED one's is the sealed snapshot its sandbox hands the control plane as it sleeps.
      markSleepCopySaving(id, pressedAt)
    }
    notePredictiveWakeSlept(id)
    // "Going to sleep…" from the click on: main first saves the copy the asleep view shows.
    markWorktreeGoingToSleep(id)
    holdActiveCloudSleepView(id)
  }
  const { errors, results, vmStillRunningIds, unsleptWorktreeIds } =
    await sleepWorktreesReportingFailures(worktreeIds, { markChatsAsleep: true })
  for (const id of worktreeIds) {
    clearWorktreeGoingToSleep(id)
    clearWorktreeKeptAwake(id)
  }
  // Refused before main started it (nothing stopped) or failed: the workspace is awake.
  for (const id of unsleptWorktreeIds) {
    releaseWorktreeSleepView(id)
  }
  // Awake after all (refused, or its machine kept running): no copy is coming.
  for (const id of [...unsleptWorktreeIds, ...vmStillRunningIds]) {
    clearSleepCopySave(id)
  }
  // A paired cloud workspace's sandbox sleeps through the control plane (PAIRED-SLEEP).
  const unslept = new Set(unsleptWorktreeIds)
  const pairedStillRunning = await sleepPairedCloudSandboxes(
    worktreeIds.filter((id) => !unslept.has(id))
  )
  const stillRunningIds = [...vmStillRunningIds, ...pairedStillRunning]
  // The paired sandbox kept running: no sealed copy is coming either.
  for (const id of pairedStillRunning) {
    clearSleepCopySave(id)
  }
  // An Orca Cloud sandbox left running gets the cloud copy (sandbox hours, Try again) instead.
  const cloudToasted = toastCloudSleepFailure(stillRunningIds, (ids) => void runSleepWorktrees(ids))
  toastSleepFailures(new Set(worktreeIds).size, errors, stillRunningIds.length > 0 && !cloudToasted)
  // A slept Orca Cloud sandbox won't restart, so its restart warning no longer applies.
  for (const result of results) {
    if (result.completed) {
      dismissOrcaCloudRestartWarning(result.workspaceId)
    }
  }
  return results
}

/** A phone or CLI's sleep that did not fully succeed: the same toast as the window's own Sleep. */
export function toastWorkspaceSleepOutcome(outcome: WorkspaceSleepOutcome): void {
  const errors = outcomeErrors(outcome)
  toastSleepFailures(1, errors, outcome.vmSuspendFailure !== undefined)
}

function outcomeErrors(outcome: WorkspaceSleepOutcome): string[] {
  if (outcome.failure !== undefined) {
    return [describeSleepFailure(new Error(outcome.failure))]
  }
  return outcome.chatFailed ? [describeChatStopFailure()] : []
}

function toastSleepFailures(
  workspaceCount: number,
  errors: readonly string[],
  vmStillRunning: boolean
): void {
  if (vmStillRunning) {
    toast.warning(describeVmSuspendFailure())
  }
  if (errors.length > 0) {
    // Why: callers are fire-and-forget; surface actionable teardown failures after restoring retryable UI state.
    toast.error(
      workspaceCount === 1
        ? translate(
            'auto.components.sidebar.sleep.worktree.flow.8bc3fc0671',
            'Failed to sleep workspace'
          )
        : translate(
            'auto.components.sidebar.sleep.worktree.flow.c460fecc4a',
            'Failed to sleep some workspaces'
          ),
      {
        description: errors.join('\n')
      }
    )
  }
}

export type WorktreeSleepOutcome = {
  /** Every workspace not verifiably slept, including one whose chat stop went unconfirmed. */
  failedWorktreeIds: string[]
  errors: string[]
  /** Slept, but the VM suspend failed: the workspace is asleep and its machine still runs. */
  vmStillRunningIds: string[]
  results: WorkspaceSleepResult[]
  /** Refused or failed outright: still awake (a chat stop left unconfirmed is not here). */
  unsleptWorktreeIds: string[]
}

/** The sleep without the toast, for callers that report failures themselves. */
/** PAIRED-ARCHIVE-STALL: how long a PAIRED workspace's host-side Sleep may take before it is left behind. */
export const PAIRED_HOST_SLEEP_TIMEOUT_MS = 30_000

/**
 * A paired workspace's host-side Sleep (its terminals, over the paired connection) can hang when that
 * connection is slow or reconnecting; then neither the control-plane suspend (what stops billing) nor
 * an Archive waiting on this Sleep ever ran (n40b). With a paired target in the batch, the host step
 * is bounded: past the timeout a paired target gets no outcome (its sandbox is still put to sleep by
 * the control plane next), and any other target reports the timeout as a failure.
 */
async function boundPairedHostSleep(
  worktreeIds: readonly string[],
  call: Promise<WorkspaceSleepOutcome[]>
): Promise<WorkspaceSleepOutcome[]> {
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

export async function sleepWorktreesReportingFailures(
  requestedWorktreeIds: readonly string[],
  // Why: only the user's Sleep hides its chats; a project move pauses through this core too.
  options: { markChatsAsleep?: boolean } = {}
): Promise<WorktreeSleepOutcome> {
  // Host twins share one ID and must sleep only once.
  const worktreeIds = [...new Set(requestedWorktreeIds)]
  if (worktreeIds.length === 0) {
    return {
      failedWorktreeIds: [],
      errors: [],
      vmStillRunningIds: [],
      results: [],
      unsleptWorktreeIds: []
    }
  }
  const state = useAppStore.getState()
  const errors: string[] = []
  const failedWorktreeIds = new Set<string>()
  const targets = worktreeIds.flatMap((worktreeId) => {
    const target = workspaceSleepTarget(state, worktreeId)
    if ('refused' in target) {
      // The window cannot name the host that runs these terminals; nothing is asked to stop.
      failedWorktreeIds.add(worktreeId)
      errors.push(describeSleepFailure(target.refused))
      return []
    }
    return [target]
  })
  const outcomes =
    targets.length > 0
      ? await boundPairedHostSleep(
          targets.map(({ worktreeId }) => worktreeId),
          window.api.worktrees
            .sleep({ targets, markChatsAsleep: options.markChatsAsleep === true })
            .catch((error: unknown): WorkspaceSleepOutcome[] =>
              targets.map(({ worktreeId }) => ({
                worktreeId,
                failure: error instanceof Error ? error.message : String(error),
                chatFailed: false,
                receipts: []
              }))
            )
        )
      : []
  const results: WorkspaceSleepResult[] = []
  const vmStillRunningIds: string[] = []
  for (const outcome of outcomes) {
    if (outcome.failure !== undefined) {
      console.error('[sleep-worktree] sleep failed', outcome)
      failedWorktreeIds.add(outcome.worktreeId)
    }
    errors.push(...outcomeErrors(outcome))
    if (outcome.vmSuspendFailure !== undefined) {
      console.error('[sleep-worktree] VM suspend failed', outcome)
      vmStillRunningIds.push(outcome.worktreeId)
    }
    const completed = outcome.failure === undefined && !outcome.chatFailed
    results.push(
      ...outcome.receipts.map((receipt) => ({
        workspaceId: outcome.worktreeId,
        ...receipt,
        completed
      }))
    )
  }
  return {
    failedWorktreeIds: [
      ...new Set([
        ...failedWorktreeIds,
        ...outcomes.flatMap((outcome) => (outcome.chatFailed ? [outcome.worktreeId] : []))
      ])
    ],
    errors: [...new Set(errors)],
    vmStillRunningIds,
    results,
    unsleptWorktreeIds: [...failedWorktreeIds]
  }
}
