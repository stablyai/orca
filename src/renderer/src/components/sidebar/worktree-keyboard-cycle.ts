import { isViewEntry, type WorktreeNavHistoryEntry } from '@/store/slices/worktree-nav-history'
import type { HostSectionRow } from '../../../../shared/sidebar-list/host-section-rows'
import type { Worktree } from '../../../../shared/worktree/types'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { PinnedWorktreeDisplayPolicy } from '../../../../shared/sidebar-list/row-types'
import {
  getRenderedWorkspaceRowsInSidebarOrder,
  type RenderedWorkspaceRow
} from './worktree-sidebar-row-preference'

/** Resolve host ownership like activation does; raw local rows omit hostId and would fail identity matching. */
export function getCyclableRowIdentity(row: RenderedWorkspaceRow): string {
  return composeWorktreeHostIdentity(
    getWorktreeExecutionHostId(row.worktree, row.repo),
    row.worktree.id
  )
}

export function getCyclableWorktreeRows(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): RenderedWorkspaceRow[] {
  return getRenderedWorkspaceRowsInSidebarOrder(rows, pinnedDisplayPolicy)
}

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

/** Use rendered sidebar rows so collapsed groups and hosts also leave the keyboard cycle. */
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

export function resolveCycleAnchorWorktreeId(args: {
  activeWorktreeId: string | null
  navHistory: readonly WorktreeNavHistoryEntry[]
  navHistoryIndex: number
  worktreeIds: readonly string[]
}): string | null {
  if (args.activeWorktreeId !== null) {
    return args.activeWorktreeId
  }
  const cyclable = new Set(args.worktreeIds)
  // Entries ahead of the cursor belong to forward navigation.
  for (
    let index = Math.min(args.navHistoryIndex, args.navHistory.length - 1);
    index >= 0;
    index--
  ) {
    const entry = args.navHistory[index]
    if (entry !== undefined && !isViewEntry(entry) && cyclable.has(entry)) {
      return entry
    }
  }
  return null
}

export type LastActiveCycleWorkspace = {
  worktreeId: string
  executionHostId: ExecutionHostId | null
}

export function resolveCycleAnchorExecutionHostId(args: {
  anchorWorktreeId: string | null
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  lastActiveWorkspace: LastActiveCycleWorkspace | null
}): ExecutionHostId | null {
  if (args.anchorWorktreeId === null) {
    return null
  }
  if (args.anchorWorktreeId === args.activeWorktreeId) {
    return args.activeWorkspaceExecutionHostId
  }
  return args.lastActiveWorkspace?.worktreeId === args.anchorWorktreeId
    ? args.lastActiveWorkspace.executionHostId
    : null
}

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
    // If collapse hides the active row, enter from the end appropriate to the navigation direction.
    return (direction === 'down' ? worktreeIds[0] : worktreeIds.at(-1)) ?? null
  }

  const step = direction === 'down' ? 1 : -1
  const nextIndex = (currentIndex + step + worktreeIds.length) % worktreeIds.length
  return worktreeIds[nextIndex] ?? null
}
