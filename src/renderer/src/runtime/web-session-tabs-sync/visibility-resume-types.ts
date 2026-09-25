import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsRemovedResult
} from '../../../../shared/runtime-types'
import type { TrackedWebSessionTabsWorktree } from './state'

export type VisibilityResumeEnvironment = {
  trackedWorktrees: readonly TrackedWebSessionTabsWorktree[]
  inventoryReceived: boolean
  latestInventoryReceivedFrame: number
  pendingMissingWorktrees: Set<string>
  expectedEnvironmentConnectionGeneration: number
  expectedEnvironmentPairingRevision?: number
  expectedTrackingGeneration: number
}

export type VisibilityResumeMissing = {
  environmentId: string
  inventoryReceivedFrame: number
  trackedWorktree: TrackedWebSessionTabsWorktree
  snapshot: RuntimeMobileSessionTabsRemovedResult
  runtimeId?: string
}

export type VisibilityResumeBatch = {
  visibilityGeneration: number
  environments: Map<string, VisibilityResumeEnvironment>
  pendingInventoryCount: number
  pendingMissingByWorktree: Map<string, Map<string, VisibilityResumeMissing>>
  deferredRepairWorktrees: Set<string>
  trackedWorktreeIds: ReadonlySet<string>
  reapplyableSnapshotsByKey: Map<
    string,
    { snapshot: RuntimeMobileSessionTabsResult; receivedFrame: number; runtimeId?: string }
  >
}

export type MirroredRuntimeEnvironment = {
  environmentId: string
  expectedEnvironmentConnectionGeneration: number
  expectedEnvironmentPairingRevision?: number
}
