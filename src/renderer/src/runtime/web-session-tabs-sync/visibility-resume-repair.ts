import {
  applyWebSessionTabsSnapshotOperations,
  decideWebSessionTabsSnapshotOperations,
  type WebSessionTabsSnapshotOperation
} from './snapshot-api'
import { applyWebSessionTabsStorePatch } from './store-patch'
import type { VisibilityResumeBatch } from './visibility-resume-types'

export function applyVisibilityResumeRepairs(
  batch: VisibilityResumeBatch,
  operations: readonly WebSessionTabsSnapshotOperation[]
): void {
  if (operations.length === 0) {
    return
  }
  const decided = decideWebSessionTabsSnapshotOperations(operations)
  const settle = applyWebSessionTabsStorePatch(
    (state, changedAgentPaneKeys) =>
      applyWebSessionTabsSnapshotOperations(state, decided, changedAgentPaneKeys),
    {
      frames: decided.map(({ environmentId, snapshot, decision }) => ({
        environmentId,
        worktreeId: snapshot.worktree,
        source: snapshot,
        decision,
        expectedEnvironmentConnectionGeneration:
          batch.environments.get(environmentId)?.expectedEnvironmentConnectionGeneration,
        expectedEnvironmentPairingRevision:
          batch.environments.get(environmentId)?.expectedEnvironmentPairingRevision,
        expectedTrackingGeneration:
          batch.environments.get(environmentId)?.expectedTrackingGeneration
      }))
    },
    operations.map(({ snapshot }) => snapshot)
  )
  settle()
}
