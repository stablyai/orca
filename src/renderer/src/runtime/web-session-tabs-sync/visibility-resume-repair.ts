import {
  applyWebSessionTabsSnapshotOperations,
  decideWebSessionTabsSnapshotOperations,
  type WebSessionTabsSnapshotOperation
} from './snapshot-api'
import { applyWebSessionTabsStorePatch } from './store-patch'
import type { VisibilityResumeBatch } from './visibility-resume-types'

/** Write the tombstone + surviving-host replay a resume repair decided on, in one store patch. */
export function applyVisibilityResumeRepairs(
  batch: VisibilityResumeBatch,
  operations: readonly WebSessionTabsSnapshotOperation[]
): void {
  if (operations.length === 0) {
    return
  }
  const decided = decideWebSessionTabsSnapshotOperations(operations)
  const settle = applyWebSessionTabsStorePatch(
    (state) => applyWebSessionTabsSnapshotOperations(state, decided),
    {
      frames: decided.map(({ environmentId, snapshot, decision }) => ({
        environmentId,
        worktreeId: snapshot.worktree,
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
