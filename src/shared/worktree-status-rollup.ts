/**
 * The worktree card's status vocabulary, widest form. `RuntimeWorktreeStatus` on the wire is
 * the subset an older client understands; the renderer uses every member.
 */
export type WorktreeRollupStatus =
  | 'inactive'
  | 'active'
  | 'done'
  | 'interrupted'
  | 'monitoring'
  | 'working'
  | 'permission'

/**
 * One ladder for the whole rollup: a worktree shows its highest-ranked signal.
 *
 * The order is a claim about what the user needs to see, not about severity. `permission`
 * outranks everything because it is the only state that cannot advance without the user.
 * The two live-work states outrank `interrupted` because work that resumed after an
 * interrupt is working, not interrupted; `interrupted` in turn outranks `done` so a
 * cancelled run never reads as a successful one.
 */
const WORKTREE_STATUS_PRIORITY: Record<WorktreeRollupStatus, number> = {
  inactive: 0,
  active: 1,
  done: 2,
  interrupted: 3,
  monitoring: 4,
  working: 5,
  permission: 6
}

export function worktreeStatusRank(status: WorktreeRollupStatus): number {
  return WORKTREE_STATUS_PRIORITY[status]
}

/** The higher-ranked of two statuses, keeping `current` on a tie. */
export function mergeWorktreeRollupStatus<T extends WorktreeRollupStatus>(current: T, next: T): T {
  return WORKTREE_STATUS_PRIORITY[next] > WORKTREE_STATUS_PRIORITY[current] ? next : current
}

/**
 * Roll a base status up over the signals a reader holds. Falsy candidates are dropped, so a
 * caller can pass `hasPermission && 'permission'` and let the ladder do the adjudication
 * rather than hand-ordering an if-chain.
 */
export function rollUpWorktreeStatus<T extends WorktreeRollupStatus>(
  base: T,
  candidates: readonly (T | false | null | undefined)[]
): T {
  let result = base
  for (const candidate of candidates) {
    if (candidate) {
      result = mergeWorktreeRollupStatus(result, candidate)
    }
  }
  return result
}
