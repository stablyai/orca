import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeSortOrderUpdate } from '../../../../../../shared/worktree/sort-order-update'
import type { AppState } from '../../../types'
import { worktreeHostMatchOptions, worktreeMatchesHost } from './worktree-host-ownership'
import { selectWorktreesByRepo } from '../../../workspace-record-selectors'

export type WorktreeSortOrderPatch = {
  repoId: string
  hostId: ExecutionHostId
  sortOrders: readonly WorktreeSortOrderUpdate[]
}

/** Apply host order saves via sortOrderEpoch; sortEpoch would schedule another live Smart save (#27268). */
export function patchWorktreeSortOrders(
  state: AppState,
  repoId: string,
  hostId: ExecutionHostId,
  sortOrders: readonly WorktreeSortOrderUpdate[]
): Pick<AppState, 'worktreesByRepo' | 'sortOrderEpoch'> | AppState {
  return patchWorktreeSortOrderBatch(state, [{ repoId, hostId, sortOrders }])
}

/** One publication for many repo buckets; later patches win for a row patched twice. */
export function patchWorktreeSortOrderBatch(
  state: AppState,
  patches: readonly WorktreeSortOrderPatch[]
): Pick<AppState, 'worktreesByRepo' | 'sortOrderEpoch'> | AppState {
  const original = selectWorktreesByRepo(state)
  let worktreesByRepo = original
  for (const { repoId, hostId, sortOrders } of patches) {
    const current = worktreesByRepo[repoId]
    if (!current || sortOrders.length === 0) {
      continue
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
    if (changed) {
      if (worktreesByRepo === original) {
        worktreesByRepo = { ...original }
      }
      worktreesByRepo[repoId] = next
    }
  }
  return worktreesByRepo === original
    ? state
    : { worktreesByRepo, sortOrderEpoch: state.sortOrderEpoch + 1 }
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
    (selectWorktreesByRepo(state)[repoId] ?? [])
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
