import type { StoreApi } from 'zustand'
import type {
  CrossMachineRecoveryApplyOp,
  RecoveryWorkspaceFragment
} from '../../../../shared/cross-machine-recovery-session-ops'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import type { AppState } from '../types'

type RecoveryStore = Pick<StoreApi<AppState>, 'getState' | 'setState'>
type SleepingRecords = AppState['sleepingAgentSessionsByPaneKey']

export type RecoveryApplySnapshot = {
  records: SleepingRecords
  workspace: { payload: WorkspaceSessionState; state: AppState } | null
}

export function captureRecoveryApplySnapshot(
  store: RecoveryStore,
  op: CrossMachineRecoveryApplyOp
): RecoveryApplySnapshot {
  const state = store.getState()
  return {
    records: state.sleepingAgentSessionsByPaneKey,
    workspace: op.kind === 'import' ? { payload: buildWorkspaceSessionPayload(state), state } : null
  }
}

function restoreKey<T>(
  current: Record<string, T>,
  previous: Record<string, T>,
  key: string
): Record<string, T> {
  const next = { ...current }
  delete next[key]
  const value = previous[key]
  if (value !== undefined) {
    next[key] = value
  }
  return next
}

function restoreImportedWorkspace(
  store: RecoveryStore,
  fragment: RecoveryWorkspaceFragment,
  before: NonNullable<RecoveryApplySnapshot['workspace']>
): void {
  const worktreeId = fragment.worktreeId
  const replaceWorkspaceKeys = [worktreeId]
  const state = store.getState()
  state.hydrateWorkspaceSession(before.payload, { replaceWorkspaceKeys })
  state.hydrateTabsSession(before.payload, { replaceWorkspaceKeys })
  const previous = before.state
  const previousFileIds = new Set(previous.openFiles.map((file) => file.id))
  store.setState((s) => ({
    openFiles: s.openFiles.filter(
      (file) => file.worktreeId !== worktreeId || previousFileIds.has(file.id)
    ),
    activeFileIdByWorktree: restoreKey(
      s.activeFileIdByWorktree,
      previous.activeFileIdByWorktree,
      worktreeId
    ),
    browserTabsByWorktree: restoreKey(
      s.browserTabsByWorktree,
      previous.browserTabsByWorktree,
      worktreeId
    ),
    browserPagesByWorkspace: Object.keys(fragment.browserPagesByWorkspace).reduce(
      (pages, key) => restoreKey(pages, previous.browserPagesByWorkspace, key),
      s.browserPagesByWorkspace
    ),
    activeBrowserTabIdByWorktree: restoreKey(
      s.activeBrowserTabIdByWorktree,
      previous.activeBrowserTabIdByWorktree,
      worktreeId
    ),
    activeTabTypeByWorktree: restoreKey(
      s.activeTabTypeByWorktree,
      previous.activeTabTypeByWorktree,
      worktreeId
    ),
    defaultTerminalTabsAppliedByWorktreeId: restoreKey(
      s.defaultTerminalTabsAppliedByWorktreeId,
      previous.defaultTerminalTabsAppliedByWorktreeId,
      worktreeId
    )
  }))
}

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
  snapshot: RecoveryApplySnapshot,
  stagedRecords: SleepingRecords
): void {
  if (op.kind === 'import' && snapshot.workspace) {
    restoreImportedWorkspace(store, op.fragment, snapshot.workspace)
  }
  restoreRecordsStagedByFailedApply(store, snapshot.records, stagedRecords)
}
