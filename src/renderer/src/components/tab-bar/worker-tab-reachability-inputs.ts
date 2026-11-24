import type { AppState } from '@/store/types'

const SEAM_WORKER_ROW_INPUT_FIELDS = [
  'tabsByWorktree',
  'unifiedTabsByWorktree',
  'migrationUnsupportedByPtyId',
  'ptyIdsByTabId',
  'terminalLayoutsByTabId',
  'runtimeAgentOrchestrationByPaneKey',
  'paneForegroundAgentByPaneKey',
  'runtimePaneTitlesByTabId',
  'agentStatusEpoch',
  'acknowledgedAgentsByPaneKey',
  'repos',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'runtimeEnvironments',
  'runtimeEnvironmentCatalogHydrated',
  'settings',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'removedRuntimeEnvironmentIds',
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId'
] as const satisfies readonly (keyof AppState)[]

export type WorkerRowMembershipSnapshot = {
  inputs: readonly unknown[]
  projection: AppState['agentStatusByPaneKey']['projection']
  revision: number
}

const snapshots = new WeakMap<AppState, WorkerRowMembershipSnapshot>()

export function captureWorkerRowMembership(state: AppState): WorkerRowMembershipSnapshot {
  const projection = state.agentStatusByPaneKey.projection
  const revision = projection.membershipRevision()
  const cached = snapshots.get(state)
  if (cached?.projection === projection && cached.revision === revision) {
    return cached
  }
  const snapshot = {
    inputs: SEAM_WORKER_ROW_INPUT_FIELDS.map((key) => state[key]),
    projection,
    revision
  }
  snapshots.set(state, snapshot)
  return snapshot
}

let lastBefore: WeakRef<WorkerRowMembershipSnapshot> | undefined
let lastAfter: WeakRef<AppState> | undefined
let sameInputs = false

/** The accepted owner versions membership separately from metadata before publishing a store write. */
export function workerRowMembershipInputsUnchanged(
  snapshot: WorkerRowMembershipSnapshot,
  after: AppState
): boolean {
  if (lastBefore?.deref() !== snapshot || lastAfter?.deref() !== after) {
    lastBefore = new WeakRef(snapshot)
    lastAfter = new WeakRef(after)
    sameInputs = true
    for (let index = 0; index < SEAM_WORKER_ROW_INPUT_FIELDS.length; index++) {
      if (snapshot.inputs[index] !== after[SEAM_WORKER_ROW_INPUT_FIELDS[index]!]) {
        sameInputs = false
        break
      }
    }
  }
  return (
    sameInputs &&
    snapshot.projection === after.agentStatusByPaneKey.projection &&
    snapshot.revision === snapshot.projection.membershipRevision()
  )
}
