import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSleepOutcome } from '../../../../shared/workspace-sleep'
import { workspaceSleepTarget } from './workspace-sleep-target'

/** One per host asked to stop the workspace's chats. */
export type WorkspaceSleepResult = {
  workspaceId: string
  executionHostId: ExecutionHostId
  stoppedSessionIds: string[]
  /** The whole workspace slept and is still asleep. */
  completed: boolean
}

/**
 * Shared "sleep worktree" flow (close all panels to free memory / CPU) used by the context menu,
 * the twin dialog and the dashboard. Main runs the sleep on each workspace's hosts; this window
 * follows main's notices (workspace-sleep-follower.ts) and shows the outcome here.
 */
export async function runSleepWorktree(worktreeId: string): Promise<WorkspaceSleepResult[]> {
  return runSleepWorktrees([worktreeId])
}

function describeSleepFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  // Why first: the twin refusal names no connection problem, though it contains "terminal_".
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
  const { errors, results, vmStillRunningIds } = await sleepWorktreesReportingFailures(
    worktreeIds,
    { markChatsAsleep: true }
  )
  toastSleepFailures(new Set(worktreeIds).size, errors, vmStillRunningIds.length > 0)
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
}

/** The sleep without the toast, for callers that report failures themselves. */
export async function sleepWorktreesReportingFailures(
  requestedWorktreeIds: readonly string[],
  // Why: only the user's Sleep hides its chats; a project move pauses through this core too.
  options: { markChatsAsleep?: boolean } = {}
): Promise<WorktreeSleepOutcome> {
  // Why unique: both copies of a twin share one id, and sleeping it sleeps the whole workspace.
  const worktreeIds = [...new Set(requestedWorktreeIds)]
  if (worktreeIds.length === 0) {
    return { failedWorktreeIds: [], errors: [], vmStillRunningIds: [], results: [] }
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
      ? await window.api.worktrees
          .sleep({ targets, markChatsAsleep: options.markChatsAsleep === true })
          .catch((error: unknown): WorkspaceSleepOutcome[] =>
            targets.map(({ worktreeId }) => ({
              worktreeId,
              failure: error instanceof Error ? error.message : String(error),
              chatFailed: false,
              receipts: []
            }))
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
    results
  }
}
