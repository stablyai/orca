import type { StoreApi } from 'zustand'
import type { CrossMachineRecoveryApplyOp } from '../../../../shared/cross-machine-recovery-session-ops'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { AppState } from '../types'
import { rollbackImportedWorkspace } from './cross-machine-recovery-import-rollback'

type RecoveryStore = Pick<StoreApi<AppState>, 'getState' | 'setState'>
type SleepingRecords = AppState['sleepingAgentSessionsByPaneKey']

function restoreRecordsStagedByFailedApply(
  store: RecoveryStore,
  before: SleepingRecords,
  staged: SleepingRecords,
  keptPaneKeys: ReadonlySet<string>
): void {
  store.setState((s) => {
    const next = { ...s.sleepingAgentSessionsByPaneKey }
    for (const paneKey of new Set([...Object.keys(before), ...Object.keys(staged)])) {
      // Why: a pane edited again since staging keeps that newer value.
      if (
        before[paneKey] === staged[paneKey] ||
        next[paneKey] !== staged[paneKey] ||
        keptPaneKeys.has(paneKey)
      ) {
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

// Why: a recovered pane the rollback kept stays blocked until its dormant binding's Resume or shell.
function importPaneKeysKeptByRollback(
  store: RecoveryStore,
  op: CrossMachineRecoveryApplyOp
): Set<string> {
  if (op.kind !== 'import') {
    return new Set()
  }
  const keptTabIds = new Set(
    (store.getState().tabsByWorktree[op.fragment.worktreeId] ?? []).map((tab) => tab.id)
  )
  return new Set(
    op.records.flatMap((record) =>
      keptTabIds.has(parsePaneKey(record.paneKey)?.tabId ?? '') ? [record.paneKey] : []
    )
  )
}

/**
 * Undoes an applied op whose persistence failed, so an unacknowledged claim or import leaves no
 * trace beyond the imported panes the user changed since staging, which keep their dormant bindings.
 */
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
    staged.sleepingAgentSessionsByPaneKey,
    importPaneKeysKeptByRollback(store, op)
  )
}
