/** The workspaces holding mail for a sleeping agent: the whole set after a (re)load, then only what changed. */
export type SleepingMailChange =
  | { worktreeIds: readonly string[] }
  | { held: readonly string[]; released: readonly string[] }

/** Applies a change to `held` in place; returns the workspaces it changed, or 'all' for a whole set. */
export function applySleepingMailChange(
  held: Set<string>,
  change: SleepingMailChange
): readonly string[] | 'all' {
  if ('worktreeIds' in change) {
    held.clear()
    for (const id of change.worktreeIds) {
      held.add(id)
    }
    return 'all'
  }
  for (const id of change.released) {
    held.delete(id)
  }
  for (const id of change.held) {
    held.add(id)
  }
  return [...change.held, ...change.released]
}
