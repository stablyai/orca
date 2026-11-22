import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

/** The store slices a workspace's owning server derives from. */
export function routingInputs(state: AppState, statuses: RuntimeStatuses): unknown[] {
  return [
    state.repos,
    selectWorktreesByRepo(state),
    selectDetectedWorktreesByRepo(state),
    state.projectGroups,
    state.restoredRuntimeHostIdByWorkspaceSessionKey,
    state.runtimeEnvironments,
    statuses
  ]
}

/** Compared by reference: store slices are replaced, never edited in place. */
export function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
