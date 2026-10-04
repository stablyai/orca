import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getDeleteStateForWorktreeHost } from '@/components/sidebar/worktree-delete-state-host-match'
import { useAppStore } from '../../store'
import {
  UNFINISHED_WORKTREE_REMOVAL_ERROR,
  settleHostWorktreeRemovals
} from '../../store/slices/worktrees/teardown/host-worktree-removal-state'

type HostMarkedRow = Pick<Worktree, 'id' | 'hostId'>
type AppStoreApi = Pick<typeof useAppStore, 'getState' | 'setState'>

// Delete states this bridge set from a host marker, keyed like deleteStateByWorktreeId. A state the
// local delete flow set is left to that flow.
const hostMarkedDeleteStates = new Map<string, HostMarkedRow>()
// Errors this bridge set from a row's `removalError`, cleared once the host stops listing it failed.
const hostFailedDeleteStates = new Map<string, HostMarkedRow & { error: string }>()

function deleteStateKey(row: HostMarkedRow): string {
  return row.hostId ? getWorktreeHostIdentity(row) : row.id
}

function showDeleteError(store: AppStoreApi, row: HostMarkedRow, error: string): void {
  store.setState((s) => ({
    deleteStateByWorktreeId: {
      ...s.deleteStateByWorktreeId,
      [deleteStateKey(row)]: {
        isDeleting: false,
        ...(row.hostId ? { executionHostId: row.hostId } : {}),
        error,
        canForceDelete: false,
        forceDeleteReason: null
      }
    }
  }))
}

function showHostFailure(store: AppStoreApi, row: Worktree & { removalError: string }): void {
  hostFailedDeleteStates.set(deleteStateKey(row), {
    id: row.id,
    hostId: row.hostId,
    error: row.removalError
  })
  showDeleteError(store, row, row.removalError)
}

/**
 * Shows the existing Deleting card while the host lists a row as removing, for views that did not
 * ask for the delete. The row leaving means it finished; the row returning unmarked means it did
 * not, and a row the host lists with `removalError` shows that error until Delete retries it.
 */
export function reconcileHostWorktreeRemovals(store: AppStoreApi = useAppStore): void {
  settleHostWorktreeRemovals()
  const listed = new Map<string, Worktree>()
  for (const rows of Object.values(store.getState().worktreesByRepo)) {
    for (const row of rows) {
      listed.set(deleteStateKey(row), row)
    }
  }
  for (const [key, shown] of hostFailedDeleteStates) {
    const row = listed.get(key)
    if (row?.removalError === shown.error && !row.removing) {
      continue
    }
    hostFailedDeleteStates.delete(key)
    const current = store.getState().deleteStateByWorktreeId[key]
    if (current && !current.isDeleting && current.error === shown.error) {
      store.getState().clearWorktreeDeleteState(shown.id, shown.hostId)
    }
  }
  const state = store.getState()
  const marked: HostMarkedRow[] = []
  for (const [key, row] of listed) {
    const current = getDeleteStateForWorktreeHost(row, state.deleteStateByWorktreeId)
    if (row.removalError && !row.removing) {
      if (!current && !hostMarkedDeleteStates.has(key)) {
        showHostFailure(store, { ...row, removalError: row.removalError })
      }
      continue
    }
    if (!row.removing || hostMarkedDeleteStates.has(key)) {
      continue
    }
    if (current?.isDeleting && current.phase !== 'queued') {
      continue
    }
    hostMarkedDeleteStates.set(key, { id: row.id, hostId: row.hostId })
    marked.push({ id: row.id, hostId: row.hostId })
  }
  if (marked.length > 0) {
    state.markWorktreesDeleting(marked)
  }
  for (const [key, row] of hostMarkedDeleteStates) {
    const listedRow = listed.get(key)
    if (listedRow?.removing) {
      continue
    }
    hostMarkedDeleteStates.delete(key)
    if (!store.getState().deleteStateByWorktreeId[key]?.isDeleting) {
      continue
    }
    if (!listedRow) {
      store.getState().clearWorktreeDeleteState(row.id, row.hostId)
    } else if (listedRow.removalError) {
      showHostFailure(store, { ...listedRow, removalError: listedRow.removalError })
    } else {
      showDeleteError(store, row, UNFINISHED_WORKTREE_REMOVAL_ERROR)
    }
  }
}

export function registerBackgroundWorktreeRemovalBridge(unsubs: (() => void)[]): void {
  let previousRows = useAppStore.getState().worktreesByRepo
  let previousDetected = useAppStore.getState().detectedWorktreesByRepo
  unsubs.push(
    useAppStore.subscribe((state) => {
      if (
        state.worktreesByRepo === previousRows &&
        state.detectedWorktreesByRepo === previousDetected
      ) {
        return
      }
      previousRows = state.worktreesByRepo
      previousDetected = state.detectedWorktreesByRepo
      reconcileHostWorktreeRemovals()
    })
  )
}

export function _resetBackgroundWorktreeRemovalBridgeForTests(): void {
  hostMarkedDeleteStates.clear()
  hostFailedDeleteStates.clear()
}
