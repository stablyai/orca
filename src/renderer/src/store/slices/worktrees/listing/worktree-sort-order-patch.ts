import type { SessionSourceEdit, OrdinarySourcePartial } from '../../../session-source-edits'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeSortOrderUpdate } from '../../../../../../shared/worktree/sort-order-update'
import type { AppState } from '../../../types'
import { worktreeHostMatchOptions, worktreeMatchesHost } from './worktree-host-ownership'

/** Apply host order saves via sortOrderEpoch; sortEpoch would schedule another live Smart save (#27268). */
export function patchWorktreeSortOrders(
  edit: SessionSourceEdit<AppState>,
  repoId: string,
  hostId: ExecutionHostId,
  sortOrders: readonly WorktreeSortOrderUpdate[]
): OrdinarySourcePartial<AppState> | undefined {
  const state = edit.view()
  const current = state.worktreesByRepo[repoId]
  if (!current || sortOrders.length === 0) {
    return undefined
  }
  const sortOrderById = new Map(sortOrders.map((entry) => [entry.worktreeId, entry.sortOrder]))
  const matchOptions = worktreeHostMatchOptions(state, repoId, hostId)
  let changed = false
  const next = current.map((worktree) => {
    const sortOrder = sortOrderById.get(worktree.id)
    if (
      sortOrder === undefined ||
      !Number.isFinite(sortOrder) ||
      worktree.sortOrder === sortOrder ||
      !worktreeMatchesHost(worktree, hostId, matchOptions)
    ) {
      return worktree
    }
    changed = true
    return { ...worktree, sortOrder }
  })
  if (!changed) {
    return undefined
  }
  edit.set('worktreesByRepo', repoId, next)
  return { sortOrderEpoch: state.sortOrderEpoch + 1 }
}

/** False when a published row is missing here, so the listing needs a refetch rather than a patch. */
export function hasHostRowsForSortOrders(
  state: AppState,
  repoId: string,
  hostId: ExecutionHostId,
  sortOrders: readonly WorktreeSortOrderUpdate[]
): boolean {
  const matchOptions = worktreeHostMatchOptions(state, repoId, hostId)
  const ids = new Set(
    (state.worktreesByRepo[repoId] ?? [])
      .filter((worktree) => worktreeMatchesHost(worktree, hostId, matchOptions))
      .map((worktree) => worktree.id)
  )
  return sortOrders.every((entry) => ids.has(entry.worktreeId))
}

/** Valid published order entries, or null when an older or malformed host sent none. */
export function readPublishedSortOrders(value: unknown): WorktreeSortOrderUpdate[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const entries: WorktreeSortOrderUpdate[] = []
  for (const entry of value) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('worktreeId' in entry) ||
      !('sortOrder' in entry) ||
      typeof entry.worktreeId !== 'string' ||
      typeof entry.sortOrder !== 'number' ||
      !Number.isFinite(entry.sortOrder)
    ) {
      return null
    }
    entries.push({ worktreeId: entry.worktreeId, sortOrder: entry.sortOrder })
  }
  return entries
}
