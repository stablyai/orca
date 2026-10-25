import type { AppState } from '@/store/types'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

/** The store slices a workspace's owning server derives from. */
export function routingInputs(state: AppState): unknown[] {
  return [
    state.repos,
    selectWorktreesByRepo(state),
    selectDetectedWorktreesByRepo(state),
    state.projectGroups,
    state.restoredRuntimeHostIdByWorkspaceSessionKey,
    state.runtimeEnvironments,
    state.runtimeStatusByEnvironmentId
  ]
}

/** Compared by reference: store slices are replaced, never edited in place. */
export function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
