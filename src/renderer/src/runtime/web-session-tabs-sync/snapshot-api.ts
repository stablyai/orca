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
  options?: WebSessionTabsSnapshotApplyOptions,
  changedAgentPaneKeys?: Set<string>
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  if (changedAgentPaneKeys) {
    return applyWebSessionTabsSnapshots(
      state,
      [snapshot],
      environmentId,
      now,
      changedAgentPaneKeys,
      options
    )
  }
  return applyWebSessionTabsSnapshotWithContext(
    state,
    snapshot,
    environmentId,
    now,
    undefined,
    options
  )
}

export function createWebSessionTabsSnapshotPatch(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
) {
  return (state: WebSessionTabsSyncState, keys: Set<string>) =>
    applyWebSessionTabsSnapshot(state, snapshot, environmentId, undefined, undefined, keys)
}

export function applyWebSessionTabsSnapshots(
  state: WebSessionTabsSyncState,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  environmentId: string,
  now = Date.now(),
  changedAgentPaneKeys?: Set<string>,
  options?: WebSessionTabsSnapshotApplyOptions
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  return applyWebSessionTabsBatch(
    state,
    snapshots.map((snapshot) => ({ snapshot, environmentId, now })),
    changedAgentPaneKeys,
    options
  )
}

function applyWebSessionTabsBatch(
  state: WebSessionTabsSyncState,
  operations: readonly {
    snapshot: RuntimeMobileSessionTabsResult
    environmentId: string
    now?: number
  }[],
  changedAgentPaneKeys?: Set<string>,
  options?: WebSessionTabsSnapshotApplyOptions
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const nextState = { ...state }
  const batchContext: WebSessionTabsBatchContext = {
    changedAgentPaneKeys,
    agentPaneKeysByTabId: null,
    changedRecords: new Set(),
    openFilesIndex: null
  }
  let mergedPatch: Partial<WebSessionTabsSyncState> = {}
  for (const { snapshot, environmentId, now } of operations) {
    const patch = applyWebSessionTabsSnapshotWithContext(
      nextState,
      snapshot,
      environmentId,
      now ?? Date.now(),
      batchContext,
      options
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
  operations: readonly DecidedWebSessionTabsSnapshotOperation[],
  changedAgentPaneKeys?: Set<string>
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  return applyWebSessionTabsBatch(
    state,
    operations.filter(({ decision }) => decision.apply),
    changedAgentPaneKeys
  )
}
