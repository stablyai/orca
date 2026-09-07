import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { recordReceivedWebSessionTabsRemoval, sessionTabsFreshnessKey } from './tracking'
import { buildMissingWebSessionTabsRemovals } from './session-tabs-inventory-absence'
import { isCurrentSessionTabsRuntimeFrame } from './publisher-identity-fences'
import type { VisibilityResumeOmission } from './state'
import type { VisibilityResumeBatch, VisibilityResumeMissing } from './visibility-resume-types'

export function recordVisibilityResumeInventoryReceipt(args: {
  batch: VisibilityResumeBatch | null
  omissions: Map<string, VisibilityResumeOmission>
  environmentId: string
  visibilityGeneration: number
  inventoryReceivedFrame: number
  snapshots: readonly RuntimeMobileSessionTabsResult[]
  hostAuthoritative: boolean
  runtimeId?: string
}): VisibilityResumeMissing[] {
  const {
    batch,
    omissions,
    environmentId,
    visibilityGeneration,
    inventoryReceivedFrame,
    snapshots,
    hostAuthoritative,
    runtimeId
  } = args
  if (!isCurrentSessionTabsRuntimeFrame(environmentId, runtimeId)) {
    return []
  }
  for (const snapshot of snapshots) {
    omissions.delete(sessionTabsFreshnessKey(environmentId, snapshot.worktree))
  }
  if (!batch || batch.visibilityGeneration !== visibilityGeneration) {
    return []
  }
  const environment = batch.environments.get(environmentId)
  if (!environment) {
    return []
  }
  environment.latestInventoryReceivedFrame = Math.max(
    environment.latestInventoryReceivedFrame,
    inventoryReceivedFrame
  )
  if (environment.latestInventoryReceivedFrame !== inventoryReceivedFrame) {
    return []
  }
  const publishedWorktrees = new Set(snapshots.map((snapshot) => snapshot.worktree))
  return buildMissingWebSessionTabsRemovals(
    environmentId,
    environment.trackedWorktrees,
    publishedWorktrees,
    hostAuthoritative
  ).map((missing) => {
    const key = sessionTabsFreshnessKey(environmentId, missing.snapshot.worktree)
    omissions.set(key, {
      baseline: missing.trackedWorktree.freshness,
      environmentId,
      inventoryReceivedFrame,
      superseded: false,
      visibilityGeneration
    })
    recordReceivedWebSessionTabsRemoval(
      environmentId,
      missing.snapshot.worktree,
      inventoryReceivedFrame
    )
    return {
      environmentId,
      inventoryReceivedFrame,
      ...(runtimeId ? { runtimeId } : {}),
      ...missing
    }
  })
}

export function recordVisibilityResumeInventory(args: {
  batch: VisibilityResumeBatch | null
  environmentId: string
  visibilityGeneration: number
  inventoryReceivedFrame: number
  missingWorktrees: readonly VisibilityResumeMissing[]
  reconcileWorktrees: (worktreeIds: Iterable<string>) => void
}): void {
  const { batch, environmentId, visibilityGeneration, inventoryReceivedFrame, missingWorktrees } =
    args
  if (!batch || visibilityGeneration === 0 || batch.visibilityGeneration !== visibilityGeneration) {
    return
  }
  const environment = batch.environments.get(environmentId)
  if (!environment || environment.latestInventoryReceivedFrame !== inventoryReceivedFrame) {
    return
  }
  const affectedWorktrees = new Set(environment.pendingMissingWorktrees)
  for (const worktreeId of environment.pendingMissingWorktrees) {
    const pendingMissing = batch.pendingMissingByWorktree.get(worktreeId)
    pendingMissing?.delete(environmentId)
    if (pendingMissing?.size === 0) {
      batch.pendingMissingByWorktree.delete(worktreeId)
    }
  }
  environment.pendingMissingWorktrees.clear()
  for (const missing of missingWorktrees) {
    const worktreeId = missing.snapshot.worktree
    const pendingMissing = batch.pendingMissingByWorktree.get(worktreeId) ?? new Map()
    pendingMissing.set(environmentId, missing)
    batch.pendingMissingByWorktree.set(worktreeId, pendingMissing)
    environment.pendingMissingWorktrees.add(worktreeId)
    affectedWorktrees.add(worktreeId)
  }
  if (!environment.inventoryReceived) {
    environment.inventoryReceived = true
    batch.pendingInventoryCount -= 1
  }
  args.reconcileWorktrees(affectedWorktrees)
}
