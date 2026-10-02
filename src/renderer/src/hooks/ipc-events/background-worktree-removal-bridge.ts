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

function deleteStateKey(row: HostMarkedRow): string {
  return row.hostId ? getWorktreeHostIdentity(row) : row.id
}

/**
 * Shows the existing Deleting card while the host lists a row as removing, for views that did not
 * ask for the delete. The row leaving means it finished; the row returning unmarked means it did not.
 */
export function reconcileHostWorktreeRemovals(store: AppStoreApi = useAppStore): void {
  settleHostWorktreeRemovals()
  const state = store.getState()
  const marked: HostMarkedRow[] = []
  const listed = new Map<string, Worktree>()
  for (const rows of Object.values(state.worktreesByRepo)) {
    for (const row of rows) {
      const key = deleteStateKey(row)
      listed.set(key, row)
      if (!row.removing || hostMarkedDeleteStates.has(key)) {
        continue
      }
      const current = getDeleteStateForWorktreeHost(row, state.deleteStateByWorktreeId)
      if (current?.isDeleting && current.phase !== 'queued') {
        continue
      }
      hostMarkedDeleteStates.set(key, { id: row.id, hostId: row.hostId })
      marked.push({ id: row.id, hostId: row.hostId })
    }
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
      continue
    }
    store.setState((s) => ({
      deleteStateByWorktreeId: {
        ...s.deleteStateByWorktreeId,
        [key]: {
          isDeleting: false,
          ...(row.hostId ? { executionHostId: row.hostId } : {}),
          error: UNFINISHED_WORKTREE_REMOVAL_ERROR,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    }))
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
}
