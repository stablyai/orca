import { isViewEntry, type WorktreeNavHistoryEntry } from '@/store/slices/worktree-nav-history'
import type { HostSectionRow } from './host-section-rows'
import type { Worktree } from '../../../../shared/worktree/types'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { PinnedWorktreeDisplayPolicy } from './worktree-list/grouping/row-types'
import {
  getRenderedWorkspaceRowsInSidebarOrder,
  type RenderedWorkspaceRow
} from './worktree-sidebar-row-preference'

/** Host-resolved identity for a cyclable row.
 *
 * Why resolved rather than `getWorktreeHostIdentity`: a local worktree carries no
 * `hostId` (`withRepoHostOwnership` leaves it unqualified), but every activation
 * path stores the host it resolved to, so raw and resolved identities never match.
 */
export function getCyclableRowIdentity(row: RenderedWorkspaceRow): string {
  return composeWorktreeHostIdentity(
    getWorktreeExecutionHostId(row.worktree, row.repo),
    row.worktree.id
  )
}

/** Why this helper: it is what Cmd+1-9 numbers from, so both shortcuts reach the
 *  same rows — folder workspaces included — in the same visual order. */
export function getCyclableWorktreeRows(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): RenderedWorkspaceRow[] {
  return getRenderedWorkspaceRowsInSidebarOrder(rows, pinnedDisplayPolicy)
}

/** Identity that locates the active workspace among the cyclable rows. */
export function resolveActiveCycleIdentity(args: {
  rows: readonly RenderedWorkspaceRow[]
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

/** Workspace ids in sidebar order, taken from the rows the sidebar actually
 *  rendered, so collapsed groups and collapsed host sections drop out on their own. */
export function getCyclableWorktreeIds(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): string[] {
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

// Why: history entries share their type with page sentinels and task details.
function historyEntryWorkspaceId(entry: WorktreeNavHistoryEntry | undefined): string | null {
  return entry === undefined || isViewEntry(entry) ? null : entry
}

/** Pick the row cycling steps from. Closing a workspace's last tab clears the selection
 *  (landing fallback), so fall back to the nav-history cursor — otherwise every keypress
 *  after a close re-enters the sidebar from its end instead of resuming where the user was. */
export function resolveCycleAnchorWorktreeId(args: {
  activeWorktreeId: string | null
  navHistory: readonly WorktreeNavHistoryEntry[]
  navHistoryIndex: number
  worktreeIds: readonly string[]
}): string | null {
  const { activeWorktreeId, navHistory, navHistoryIndex } = args
  // Why pass an uncyclable selection through: it means the row sits in a collapsed
  // group, which resolveCycledWorktreeId answers by entering from the far end.
  if (activeWorktreeId !== null) {
    return activeWorktreeId
  }
  const cyclable = new Set(args.worktreeIds)
  // Why not past the cursor: entries ahead of it are the goForward branch, not where the user is.
  for (let index = Math.min(navHistoryIndex, navHistory.length - 1); index >= 0; index--) {
    const workspaceId = historyEntryWorkspaceId(navHistory[index])
    if (workspaceId !== null && cyclable.has(workspaceId)) {
      return workspaceId
    }
  }
  return null
}

/** Pick the worktree that `worktree.navigateUp` / `worktree.navigateDown` moves
 *  to, cycling within the worktrees the sidebar is currently showing. */
export function resolveCycledWorktreeId(args: {
  worktreeIds: readonly string[]
  anchorWorktreeId: string | null
  direction: 'up' | 'down'
}): string | null {
  const { worktreeIds, direction } = args
  if (worktreeIds.length === 0) {
    return null
  }

  const currentIndex = args.anchorWorktreeId ? worktreeIds.indexOf(args.anchorWorktreeId) : -1
  if (currentIndex === -1) {
    // Why: the anchor can sit inside a collapsed group, so it is absent from the
    // cyclable list; enter from the end the keypress points away from.
    return (direction === 'down' ? worktreeIds[0] : worktreeIds.at(-1)) ?? null
  }

  const step = direction === 'down' ? 1 : -1
  const nextIndex = (currentIndex + step + worktreeIds.length) % worktreeIds.length
  return worktreeIds[nextIndex] ?? null
}
