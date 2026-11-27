import type { LocalTask } from './local-task-types'

export type LocalTaskReadiness =
  | { id: string; state: 'ready' }
  | { id: string; state: 'waiting'; on: string[] }
  | { id: string; state: 'claimed'; by: string }
  // Needs a person: a dependency was dropped or does not exist (never silently unblocked).
  | { id: string; state: 'flagged'; reason: string }
  // Already started, blocked, or finished: not the scheduler's to pick.
  | { id: string; state: 'inactive' }

export const DEFAULT_LEASE_MS = 30 * 60 * 1000

const norm = (status: string): string => status.trim().toLowerCase()

/** Classifies every task; pure, so the scheduler, UI and mobile share one answer. */
export function computeLocalTaskReadiness(
  tasks: LocalTask[],
  options: { now?: number; leaseMs?: number } = {}
): LocalTaskReadiness[] {
  const now = options.now ?? Date.now()
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return tasks.map((task): LocalTaskReadiness => {
    // A claim past its lease is treated as abandoned (the agent died).
    const claimedAt = task.claimedAt ? Date.parse(task.claimedAt) : Number.NaN
    const leaseExpired = Number.isFinite(claimedAt) && now - claimedAt > leaseMs
    // A crashed agent leaves its task 'working'; with an expired lease it is claimable again.
    const abandoned = task.statusCategory === 'in-progress' && !!task.claimedBy && leaseExpired
    if (task.statusCategory !== 'todo' && !abandoned) {
      return { id: task.id, state: 'inactive' }
    }
    if (task.claimedBy && !leaseExpired) {
      return { id: task.id, state: 'claimed', by: task.claimedBy }
    }
    const waitingOn: string[] = []
    for (const depId of task.dependsOn) {
      const dep = byId.get(depId)
      if (!dep) {
        return { id: task.id, state: 'flagged', reason: `missing dependency ${depId}` }
      }
      if (norm(dep.status) === 'dropped') {
        return { id: task.id, state: 'flagged', reason: `dependency ${depId} was dropped` }
      }
      if (dep.statusCategory !== 'done') {
        waitingOn.push(depId)
      }
    }
    // ponytail: a dependency cycle just stays 'waiting'; add cycle detection if it bites.
    return waitingOn.length > 0
      ? { id: task.id, state: 'waiting', on: waitingOn }
      : { id: task.id, state: 'ready' }
  })
}

/** Ready tasks, best first (priority, then oldest update), capped at `slots`. */
export function pickReadyLocalTasks(
  tasks: LocalTask[],
  slots: number,
  options: { now?: number; leaseMs?: number } = {}
): LocalTask[] {
  const ready = new Set(
    computeLocalTaskReadiness(tasks, options)
      .filter((r) => r.state === 'ready')
      .map((r) => r.id)
  )
  return tasks
    .filter((task) => ready.has(task.id))
    .sort((a, b) => a.priority - b.priority || (a.updatedAt ?? '').localeCompare(b.updatedAt ?? ''))
    .slice(0, Math.max(0, slots))
}
