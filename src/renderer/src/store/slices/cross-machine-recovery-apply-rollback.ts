import type { StoreApi } from 'zustand'
import type { CrossMachineRecoveryApplyOp } from '../../../../shared/cross-machine-recovery-session-ops'
import type { AppState } from '../types'
import { rollbackImportedWorkspace } from './cross-machine-recovery-import-rollback'

type RecoveryStore = Pick<StoreApi<AppState>, 'getState' | 'setState'>
type SleepingRecords = AppState['sleepingAgentSessionsByPaneKey']

function restoreRecordsStagedByFailedApply(
  store: RecoveryStore,
  before: SleepingRecords,
  staged: SleepingRecords
): void {
  store.setState((s) => {
    const next = { ...s.sleepingAgentSessionsByPaneKey }
    for (const paneKey of new Set([...Object.keys(before), ...Object.keys(staged)])) {
      // Why: a pane edited again since staging keeps that newer value.
      if (before[paneKey] === staged[paneKey] || next[paneKey] !== staged[paneKey]) {
        continue
      }
      const previous = before[paneKey]
      if (previous) {
        next[paneKey] = previous
      } else {
        delete next[paneKey]
      }
    }
    return { sleepingAgentSessionsByPaneKey: next }
  })
}

/** Undoes an applied op whose persistence failed, so an unacknowledged claim or import leaves no trace. */
export function rollbackFailedRecoveryApply(
  store: RecoveryStore,
  op: CrossMachineRecoveryApplyOp,
  before: AppState,
  staged: AppState
): void {
  if (op.kind === 'import') {
    rollbackImportedWorkspace(store, op.fragment.worktreeId, before, staged)
  }
  restoreRecordsStagedByFailedApply(
    store,
    before.sleepingAgentSessionsByPaneKey,
    staged.sleepingAgentSessionsByPaneKey
  )
}
