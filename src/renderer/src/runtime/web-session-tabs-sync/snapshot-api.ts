import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type {
  WebSessionTabsBatchContext,
  WebSessionTabsSnapshotApplyOptions,
  WebSessionTabsSyncState
} from './state'
import { applyWebSessionTabsSnapshotWithContext } from './apply-snapshot'
import {
  decideWebSessionTabsSnapshot,
  shouldApplyWebSessionTabsSnapshot,
  type WebSessionTabsSnapshotDecision
} from './tracking-decisions'

export function applyWebSessionTabsSnapshot(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now(),
  options?: WebSessionTabsSnapshotApplyOptions
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  return applyWebSessionTabsSnapshotWithContext(
    state,
    snapshot,
    environmentId,
    now,
    undefined,
    options
  )
}

export function applyWebSessionTabsSnapshots(
  state: WebSessionTabsSyncState,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const nextState = { ...state }
  const batchContext: WebSessionTabsBatchContext = {
    agentPaneKeysByTabId: null,
    changedRecords: new Set(),
    openFilesIndex: null
  }
  let mergedPatch: Partial<WebSessionTabsSyncState> = {}
  for (const snapshot of snapshots) {
    const patch = applyWebSessionTabsSnapshotWithContext(
      nextState,
      snapshot,
      environmentId,
      now,
      batchContext
    )
    if (patch === nextState) {
      continue
    }
    mergedPatch = { ...mergedPatch, ...patch }
    Object.assign(nextState, patch)
  }
  const mutableMergedPatch = mergedPatch as Record<string, unknown>
  const mutableNextState = nextState as unknown as Record<string, unknown>
  for (const recordKey of batchContext.changedRecords) {
    mutableMergedPatch[recordKey] = mutableNextState[recordKey]
  }
  return Object.keys(mergedPatch).length === 0 ? state : mergedPatch
}

export function applyFreshWebSessionTabsSnapshot(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  return shouldApplyWebSessionTabsSnapshot(snapshot, environmentId)
    ? applyWebSessionTabsSnapshot(state, snapshot, environmentId, now)
    : state
}

export function applyFreshWebSessionTabsSnapshots(
  state: WebSessionTabsSyncState,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const fresh = snapshots.filter((snapshot) =>
    shouldApplyWebSessionTabsSnapshot(snapshot, environmentId)
  )
  return fresh.length === 0 ? state : applyWebSessionTabsSnapshots(state, fresh, environmentId, now)
}

export type WebSessionTabsSnapshotOperation = {
  environmentId: string
  snapshot: RuntimeMobileSessionTabsResult
  runtimeId?: string
}

export type DecidedWebSessionTabsSnapshotOperation = WebSessionTabsSnapshotOperation & {
  decision: WebSessionTabsSnapshotDecision
}

export function decideWebSessionTabsSnapshotOperations(
  operations: readonly WebSessionTabsSnapshotOperation[]
): DecidedWebSessionTabsSnapshotOperation[] {
  return operations.map((operation) => ({
    ...operation,
    decision: decideWebSessionTabsSnapshot(
      operation.snapshot,
      operation.environmentId,
      operation.runtimeId
    )
  }))
}

export function applyWebSessionTabsSnapshotOperations(
  state: WebSessionTabsSyncState,
  operations: readonly DecidedWebSessionTabsSnapshotOperation[]
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  let nextState = state
  let mergedPatch: Partial<WebSessionTabsSyncState> = {}
  for (const { environmentId, snapshot, decision } of operations) {
    if (!decision.apply) {
      continue
    }
    const patch = applyWebSessionTabsSnapshot(nextState, snapshot, environmentId)
    if (patch === nextState) {
      continue
    }
    mergedPatch = { ...mergedPatch, ...patch }
    nextState = { ...nextState, ...patch }
  }
  return Object.keys(mergedPatch).length === 0 ? state : mergedPatch
}
