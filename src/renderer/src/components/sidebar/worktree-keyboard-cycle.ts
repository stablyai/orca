import type { HostSectionRow } from './host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from './worktree-list-groups'
import { getRenderedWorktreesInSidebarOrder } from './worktree-sidebar-row-preference'

/** Workspace ids in sidebar order, taken from the rows the sidebar actually
 *  rendered, so collapsed groups and collapsed host sections drop out on their own. */
export function getCyclableWorktreeIds(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): string[] {
  // Why folder rows too: they are real sidebar cards reachable by Cmd+1–9, so
  // arrowing past them would make the two orders disagree; `folder:` keys route
  // through activateAndRevealWorkspace.
  const ids: string[] = []
  const seen = new Set<string>()
  for (const workspace of getRenderedWorktreesInSidebarOrder(rows, pinnedDisplayPolicy)) {
    if (seen.has(workspace.id)) {
      continue
    }
    seen.add(workspace.id)
    ids.push(workspace.id)
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
