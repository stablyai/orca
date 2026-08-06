import type { HostSectionRow } from './host-section-rows'
import type { PinnedWorktreeDisplayPolicy, WorktreeRow } from './worktree-list-groups'
import { getPreferredWorktreeRows } from './worktree-sidebar-row-preference'

/** Worktree ids in sidebar order, taken from the rows the sidebar actually
 *  rendered, so collapsed groups and collapsed host sections drop out on their own. */
export function getCyclableWorktreeIds(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): string[] {
  // Why item-only: folder workspaces render as their own row type and are not
  // activatable through activateAndRevealWorktree, so cycling has never included them.
  const itemRows = rows.filter((row): row is WorktreeRow => row.type === 'item')
  const ids: string[] = []
  const seen = new Set<string>()
  for (const row of getPreferredWorktreeRows(itemRows, pinnedDisplayPolicy)) {
    if (seen.has(row.worktree.id)) {
      continue
    }
    seen.add(row.worktree.id)
    ids.push(row.worktree.id)
  }
  return ids
}

/** Pick the worktree that `worktree.navigateUp` / `worktree.navigateDown` moves
 *  to, cycling within the worktrees the sidebar is currently showing. */
export function resolveCycledWorktreeId(args: {
  worktreeIds: readonly string[]
  activeWorktreeId: string | null
  direction: 'up' | 'down'
}): string | null {
  const { worktreeIds, direction } = args
  if (worktreeIds.length === 0) {
    return null
  }

  const currentIndex = args.activeWorktreeId ? worktreeIds.indexOf(args.activeWorktreeId) : -1
  if (currentIndex === -1) {
    // Why: the active worktree can sit inside a collapsed group, so it is absent
    // from the cyclable list; enter from the end the keypress points away from.
    return (direction === 'down' ? worktreeIds[0] : worktreeIds.at(-1)) ?? null
  }

  const step = direction === 'down' ? 1 : -1
  const nextIndex = (currentIndex + step + worktreeIds.length) % worktreeIds.length
  return worktreeIds[nextIndex] ?? null
}
