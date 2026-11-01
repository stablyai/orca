import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getDeleteStateForWorktreeHost } from '@/components/sidebar/worktree-delete-state-host-match'
import { useAppStore } from '../../store'
import {
  UNFINISHED_WORKTREE_REMOVAL_ERROR,
  settleHostWorktreeRemovals
} from '../../store/slices/worktrees/teardown/host-worktree-removal-state'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

type HostMarkedRow = Pick<Worktree, 'id' | 'hostId'>
type AppStoreApi = Pick<typeof useAppStore, 'getState' | 'setState'>

// Track only host-marker delete state; locally initiated flows retain their own state.
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

/** Mirror host removal markers into Deleting/error cards: disappearing rows finished, while unmarked returns did not; retain reported errors until retry. */
export function reconcileHostWorktreeRemovals(store: AppStoreApi = useAppStore): void {
  settleHostWorktreeRemovals()
  const listed = new Map<string, Worktree>()
  for (const rows of Object.values(selectWorktreesByRepo(store.getState()))) {
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
  let previousRows = selectWorktreesByRepo(useAppStore.getState())
  let previousDetected = selectDetectedWorktreesByRepo(useAppStore.getState())
  unsubs.push(
    useAppStore.subscribe((state) => {
      if (
        selectWorktreesByRepo(state) === previousRows &&
        selectDetectedWorktreesByRepo(state) === previousDetected
      ) {
        return
      }
      previousRows = selectWorktreesByRepo(state)
      previousDetected = selectDetectedWorktreesByRepo(state)
      reconcileHostWorktreeRemovals()
    })
  )
}

export function _resetBackgroundWorktreeRemovalBridgeForTests(): void {
  hostMarkedDeleteStates.clear()
  hostFailedDeleteStates.clear()
}
