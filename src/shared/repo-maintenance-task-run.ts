import {
  RepoMaintenanceRepoLocked,
  type PackedRefsLockReporter,
  type RepoMaintenanceSpan,
  type RepoMaintenanceTask,
  type RepoMaintenanceTaskOutcome
} from './repo-maintenance-policy'

/**
 * One task's turn: probe, compare to its threshold, pack, re-probe, and report
 * what happened.
 *
 * Split out from the scheduler because none of it is scheduling. The scheduler
 * decides whether a task may run at all -- quiet period, busy gate, admission
 * slot, cooldown -- and this decides what the run was worth.
 */

export type RepoMaintenanceTaskVerdict = {
  outcome: RepoMaintenanceTaskOutcome
  /** The task deliberately left work behind and is owed another turn. */
  remainder: boolean
}

export async function runMaintenanceTask(
  task: RepoMaintenanceTask,
  span: RepoMaintenanceSpan,
  lock: PackedRefsLockReporter,
  signal: AbortSignal,
  now: () => number
): Promise<RepoMaintenanceTaskVerdict> {
  const attribute = (name: string): string => `repo.maintenance.${task.id}.${name}`
  const budget = task.threshold + 1
  const before = await task.probeBacklog(budget, signal)
  if (!before) {
    return finish(span, task, { outcome: 'unresolved', remainder: false })
  }
  span.setAttribute(attribute('backlog'), before.count)
  span.setAttribute(attribute('threshold'), task.threshold)
  // A saturated probe stopped early, so `count` is a floor -- never read it as "clean".
  if (!before.saturated && before.count < task.threshold) {
    return finish(span, task, { outcome: 'below_threshold', remainder: false })
  }
  const startedAt = now()
  let partial = false
  let batchExhausted = false
  try {
    // No signal: the pack runs to completion. Callers that need the refs wait
    // out the rewrite window through `pause()` instead of killing it.
    batchExhausted = (await task.pack(lock)).batchExhausted
  } catch (error) {
    span.setAttribute(attribute('error'), String(error))
    if (error instanceof RepoMaintenanceRepoLocked) {
      return finish(span, task, { outcome: 'locked', remainder: false })
    }
    partial = true
  } finally {
    lock.setHeld(false)
  }
  span.setAttribute(attribute('duration_ms'), now() - startedAt)
  // Judge by the backlog, not by the exit code. On a machine running several
  // Orca sessions a branch moving mid-pack is the normal case, and Git's
  // response -- leave that one ref loose, pack the rest -- is the correct one.
  // Measured in the field: 36,688 loose refs down to 3, reported as an error.
  const after = await task.probeBacklog(budget, signal)
  span.setAttribute(attribute('backlog_after'), after?.count ?? null)
  // An unresolvable or truncated re-probe is not evidence the backlog is gone.
  if (after && !after.saturated && after.count < task.threshold) {
    span.setAttribute(attribute('partial'), partial)
    return finish(span, task, { outcome: 'packed', remainder: false })
  }
  // The batch was spent, not the backlog: owe the rest rather than cooling
  // down. A pack that threw is never owed another turn on this footing --
  // something is wrong with the repository, not with how much of it we took.
  return batchExhausted && !partial
    ? finish(span, task, { outcome: 'partially_packed', remainder: true })
    : finish(span, task, { outcome: 'failed', remainder: false })
}

function finish(
  span: RepoMaintenanceSpan,
  task: RepoMaintenanceTask,
  verdict: RepoMaintenanceTaskVerdict
): RepoMaintenanceTaskVerdict {
  span.setAttribute(`repo.maintenance.${task.id}.outcome`, verdict.outcome)
  return verdict
}
