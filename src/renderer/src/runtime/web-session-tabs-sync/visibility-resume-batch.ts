import { getTrackedWebSessionTabsWorktrees } from './tracking'
import { getWebSessionTabsTrackingGeneration } from './tracking-lifecycle'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import type { VisibilityResumeOmission } from './state'
import type {
  MirroredRuntimeEnvironment,
  VisibilityResumeBatch,
  VisibilityResumeEnvironment
} from './visibility-resume-types'

/** Build the inventory/replay state for the subscriptions restarted by a resume. */
export function buildVisibilityResumeBatch(args: {
  visibilityGeneration: number
  restartingSpecIndexes: readonly number[]
  environmentIdBySubscriptionSpec: readonly string[]
  environments: readonly MirroredRuntimeEnvironment[]
  omissions: Map<string, VisibilityResumeOmission>
  activeRuntimeWorktreeKey: () => string | null
}): VisibilityResumeBatch | null {
  const activeKey = args.activeRuntimeWorktreeKey()
  for (const [key, omission] of args.omissions) {
    if (key !== activeKey || omission.visibilityGeneration < args.visibilityGeneration - 1) {
      args.omissions.delete(key)
    }
  }
  const resumed = new Map<string, VisibilityResumeEnvironment>()
  const trackedWorktreeIds = new Set<string>()
  for (const index of args.restartingSpecIndexes) {
    const environmentId = args.environmentIdBySubscriptionSpec[index]
    if (!environmentId) {
      continue
    }
    const trackedWorktrees = getTrackedWebSessionTabsWorktrees(environmentId)
    if (trackedWorktrees.length === 0) {
      continue
    }
    for (const { worktree } of trackedWorktrees) {
      trackedWorktreeIds.add(worktree)
    }
    const descriptor = args.environments.find((entry) => entry.environmentId === environmentId)
    resumed.set(environmentId, {
      trackedWorktrees,
      inventoryReceived: false,
      latestInventoryReceivedFrame: 0,
      pendingMissingWorktrees: new Set(),
      expectedEnvironmentConnectionGeneration:
        descriptor?.expectedEnvironmentConnectionGeneration ??
        getRuntimeEnvironmentConnectionGeneration(environmentId),
      expectedEnvironmentPairingRevision: descriptor?.expectedEnvironmentPairingRevision,
      expectedTrackingGeneration: getWebSessionTabsTrackingGeneration(environmentId)
    })
  }
  return resumed.size
    ? {
        visibilityGeneration: args.visibilityGeneration,
        environments: resumed,
        pendingInventoryCount: resumed.size,
        pendingMissingByWorktree: new Map(),
        deferredRepairWorktrees: new Set(),
        trackedWorktreeIds,
        reapplyableSnapshotsByKey: new Map()
      }
    : null
}
