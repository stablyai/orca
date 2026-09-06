import type { HostSectionRow } from './host-section-rows'
import type { Worktree } from '../../../../shared/worktree/types'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { PinnedWorktreeDisplayPolicy, WorktreeRow } from './worktree-list/grouping/row-types'
import { getPreferredWorktreeRows } from './worktree-sidebar-row-preference'

/** Host-resolved identity for a cyclable row.
 *
 * Why resolved rather than `getWorktreeHostIdentity`: a local worktree carries no
 * `hostId` (`withRepoHostOwnership` leaves it unqualified), but every activation
 * path stores the host it resolved to, so raw and resolved identities never match.
 */
export function getCyclableRowIdentity(row: Pick<WorktreeRow, 'worktree' | 'repo'>): string {
  return composeWorktreeHostIdentity(
    getWorktreeExecutionHostId(row.worktree, row.repo),
    row.worktree.id
  )
}

export function getCyclableWorktreeRows(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): WorktreeRow[] {
  const itemRows = rows.filter((row): row is WorktreeRow => row.type === 'item')
  return getPreferredWorktreeRows(itemRows, pinnedDisplayPolicy)
}

/** Identity that locates the active workspace among the cyclable rows. */
export function resolveActiveCycleIdentity(args: {
  rows: readonly WorktreeRow[]
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
}): string | null {
  const { rows, activeWorktreeId, activeWorkspaceExecutionHostId } = args
  if (!activeWorktreeId) {
    return null
  }
  if (activeWorkspaceExecutionHostId) {
    return composeWorktreeHostIdentity(activeWorkspaceExecutionHostId, activeWorktreeId)
  }
  // Host-unqualified activation names no host; the row it landed on does.
  const row = rows.find((candidate) => candidate.worktree.id === activeWorktreeId)
  return row ? getCyclableRowIdentity(row) : null
}

/** Worktree ids in sidebar order, taken from the rows the sidebar actually
 *  rendered, so collapsed groups and collapsed host sections drop out on their own. */
export function getCyclableWorktreeIds(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): string[] {
  // Why item-only: folder workspaces render as their own row type and are not
  // activatable through activateAndRevealWorktree, so cycling has never included them.
  const ids: string[] = []
  const seen = new Set<string>()
  for (const row of getCyclableWorktreeRows(rows, pinnedDisplayPolicy)) {
    const identity = getCyclableRowIdentity(row)
    if (seen.has(identity)) {
      continue
    }
    seen.add(identity)
    ids.push(row.worktree.id)
  }
  return ids
}

export function getCyclableWorktrees(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): Worktree[] {
  return getCyclableWorktreeRows(rows, pinnedDisplayPolicy).map((row) => row.worktree)
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
