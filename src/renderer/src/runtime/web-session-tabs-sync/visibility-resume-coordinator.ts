import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  advancesSessionTabsFreshness,
  shouldApplyRecoveredWebSessionTabsSnapshot,
  sessionTabsFreshnessKey
} from './tracking'
import { latestSessionTabsSnapshotByWorktree, sessionTabsEnvironmentsByWorktree } from './state'
import {
  isCurrentSessionTabsRuntimeId,
  isRetiredSessionTabsRuntimeId
} from './publisher-identity-fences'
import { acceptReplayedWebSessionTabsSnapshot } from './tracking-lifecycle'
import type { WebSessionTabsSnapshotOperation } from './snapshot-api'
import { applyVisibilityResumeRepairs } from './visibility-resume-repair'
import {
  recordVisibilityResumeInventory,
  recordVisibilityResumeInventoryReceipt
} from './visibility-resume-inventory'
import type { VisibilityResumeOmission } from './state'
import type {
  MirroredRuntimeEnvironment,
  VisibilityResumeBatch,
  VisibilityResumeMissing
} from './visibility-resume-types'
import { buildVisibilityResumeBatch } from './visibility-resume-batch'

export type VisibilityResumeCoordinatorOptions = {
  environments: readonly MirroredRuntimeEnvironment[]
  environmentIdBySubscriptionSpec: readonly string[]
  omissions: Map<string, VisibilityResumeOmission>
  activeRuntimeWorktreeKey: () => string | null
}

/** Coordinates inventory omissions and cross-environment replay during visibility resumes. */
export class VisibilityResumeCoordinator {
  private batch: VisibilityResumeBatch | null = null

  constructor(private readonly options: VisibilityResumeCoordinatorOptions) {}

  recordSnapshotReceipt(
    environmentId: string,
    snapshot: RuntimeMobileSessionTabsResult,
    receivedFrame: number,
    runtimeId?: string
  ): void {
    if (runtimeId && this.isSupersededRuntimeId(environmentId, runtimeId)) {
      return
    }
    const omission = this.options.omissions.get(
      sessionTabsFreshnessKey(environmentId, snapshot.worktree)
    )
    if (
      omission &&
      receivedFrame > omission.inventoryReceivedFrame &&
      ((snapshot as { removed?: unknown }).removed === true ||
        advancesSessionTabsFreshness(snapshot, omission.baseline))
    ) {
      omission.superseded = true
      if (this.batch?.pendingMissingByWorktree.has(snapshot.worktree)) {
        this.reconcileWorktrees([snapshot.worktree])
      }
    }
  }

  shouldApplySnapshot(
    environmentId: string,
    snapshot: RuntimeMobileSessionTabsResult,
    receivedFrame: number,
    runtimeId?: string
  ): boolean {
    if (runtimeId && this.isSupersededRuntimeId(environmentId, runtimeId)) {
      return false
    }
    const omission = this.options.omissions.get(
      sessionTabsFreshnessKey(environmentId, snapshot.worktree)
    )
    if (!omission) {
      return true
    }
    if (receivedFrame < omission.inventoryReceivedFrame) {
      return false
    }
    return (
      (snapshot as { removed?: unknown }).removed === true ||
      advancesSessionTabsFreshness(snapshot, omission.baseline)
    )
  }

  /** A frame from a retired or non-current host process cannot steer this resume. */
  private isSupersededRuntimeId(environmentId: string, runtimeId: string): boolean {
    return (
      isRetiredSessionTabsRuntimeId(environmentId, runtimeId) ||
      !isCurrentSessionTabsRuntimeId(environmentId, runtimeId)
    )
  }

  private missingCurrent(missing: VisibilityResumeMissing): boolean {
    const omission = this.options.omissions.get(
      sessionTabsFreshnessKey(missing.environmentId, missing.snapshot.worktree)
    )
    return (
      omission?.inventoryReceivedFrame === missing.inventoryReceivedFrame && !omission.superseded
    )
  }

  private replayableEntry(
    batch: VisibilityResumeBatch,
    environmentId: string,
    worktreeId: string
  ): {
    snapshot: RuntimeMobileSessionTabsResult
    receivedFrame: number
    runtimeId?: string
  } | null {
    const key = sessionTabsFreshnessKey(environmentId, worktreeId)
    const entry = batch.reapplyableSnapshotsByKey.get(key)
    const freshness = entry ? latestSessionTabsSnapshotByWorktree.get(key) : undefined
    if (
      !entry ||
      !freshness ||
      freshness.publicationEpoch !== entry.snapshot.publicationEpoch ||
      freshness.snapshotVersion !== entry.snapshot.snapshotVersion ||
      !shouldApplyRecoveredWebSessionTabsSnapshot(
        environmentId,
        entry.snapshot,
        entry.receivedFrame,
        entry.runtimeId
      )
    ) {
      return null
    }
    return entry
  }

  private replayableSnapshot(
    batch: VisibilityResumeBatch,
    environmentId: string,
    worktreeId: string
  ): RuntimeMobileSessionTabsResult | null {
    return this.replayableEntry(batch, environmentId, worktreeId)?.snapshot ?? null
  }

  private finishIfIdle(batch: VisibilityResumeBatch): void {
    if (
      batch.pendingInventoryCount === 0 &&
      batch.pendingMissingByWorktree.size === 0 &&
      this.batch === batch
    ) {
      this.batch = null
    }
  }

  private reconcileWorktrees(worktreeIds: Iterable<string>): void {
    const batch = this.batch
    if (!batch) {
      return
    }
    const operations: WebSessionTabsSnapshotOperation[] = []
    for (const worktreeId of new Set(worktreeIds)) {
      const pendingMissing = batch.pendingMissingByWorktree.get(worktreeId)
      if (!pendingMissing) {
        batch.deferredRepairWorktrees.delete(worktreeId)
        continue
      }
      for (const [environmentId, missing] of pendingMissing) {
        if (this.missingCurrent(missing)) {
          continue
        }
        pendingMissing.delete(environmentId)
        batch.environments.get(environmentId)?.pendingMissingWorktrees.delete(worktreeId)
      }
      if (pendingMissing.size === 0) {
        batch.pendingMissingByWorktree.delete(worktreeId)
        batch.deferredRepairWorktrees.delete(worktreeId)
        continue
      }
      const missingEnvironmentIds = new Set(pendingMissing.keys())
      const survivingSnapshots: {
        environmentId: string
        snapshot: RuntimeMobileSessionTabsResult
        runtimeId?: string
      }[] = []
      let canRepair = true
      for (const environmentId of sessionTabsEnvironmentsByWorktree.get(worktreeId) ?? []) {
        if (missingEnvironmentIds.has(environmentId)) {
          continue
        }
        const entry = this.replayableEntry(batch, environmentId, worktreeId)
        if (!entry) {
          canRepair = false
          break
        }
        survivingSnapshots.push({
          environmentId,
          snapshot: entry.snapshot,
          ...(entry.runtimeId ? { runtimeId: entry.runtimeId } : {})
        })
      }
      if (!canRepair) {
        batch.deferredRepairWorktrees.add(worktreeId)
        continue
      }
      for (const missing of pendingMissing.values()) {
        operations.push({
          environmentId: missing.environmentId,
          snapshot: missing.snapshot,
          ...(missing.runtimeId ? { runtimeId: missing.runtimeId } : {})
        })
      }
      for (const { environmentId, snapshot, runtimeId } of survivingSnapshots) {
        acceptReplayedWebSessionTabsSnapshot(environmentId, worktreeId)
        operations.push({ environmentId, snapshot, ...(runtimeId ? { runtimeId } : {}) })
      }
      for (const environmentId of pendingMissing.keys()) {
        batch.environments.get(environmentId)?.pendingMissingWorktrees.delete(worktreeId)
      }
      batch.pendingMissingByWorktree.delete(worktreeId)
      batch.deferredRepairWorktrees.delete(worktreeId)
    }
    applyVisibilityResumeRepairs(batch, operations)
    this.finishIfIdle(batch)
  }

  recordSnapshot(
    environmentId: string,
    snapshot: RuntimeMobileSessionTabsResult,
    receivedFrame: number,
    runtimeId?: string
  ): void {
    if (runtimeId && this.isSupersededRuntimeId(environmentId, runtimeId)) {
      return
    }
    const batch = this.batch
    if (!batch || !batch.trackedWorktreeIds.has(snapshot.worktree)) {
      return
    }
    const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
    const existing = this.replayableSnapshot(batch, environmentId, snapshot.worktree)
    const freshness = latestSessionTabsSnapshotByWorktree.get(key)
    const crossHost =
      (sessionTabsEnvironmentsByWorktree.get(snapshot.worktree)?.size ?? 0) > 1 ||
      batch.deferredRepairWorktrees.has(snapshot.worktree)
    if (
      (snapshot as { removed?: unknown }).removed === true ||
      snapshot.tabs.length === 0 ||
      !crossHost ||
      freshness?.publicationEpoch !== snapshot.publicationEpoch ||
      freshness.snapshotVersion !== snapshot.snapshotVersion ||
      !shouldApplyRecoveredWebSessionTabsSnapshot(environmentId, snapshot, receivedFrame, runtimeId)
    ) {
      if (!existing) {
        batch.reapplyableSnapshotsByKey.delete(key)
      }
    } else {
      batch.reapplyableSnapshotsByKey.set(key, { snapshot, receivedFrame, runtimeId })
    }
    if (batch.pendingMissingByWorktree.has(snapshot.worktree)) {
      this.reconcileWorktrees([snapshot.worktree])
    }
  }

  recordInventory(
    environmentId: string,
    visibilityGeneration: number,
    inventoryReceivedFrame: number,
    missingWorktrees: readonly VisibilityResumeMissing[]
  ): void {
    recordVisibilityResumeInventory({
      batch: this.batch,
      environmentId,
      visibilityGeneration,
      inventoryReceivedFrame,
      missingWorktrees,
      reconcileWorktrees: (worktreeIds) => this.reconcileWorktrees(worktreeIds)
    })
  }

  recordInventoryReceipt(
    environmentId: string,
    visibilityGeneration: number,
    inventoryReceivedFrame: number,
    snapshots: readonly RuntimeMobileSessionTabsResult[],
    hostAuthoritative: boolean,
    runtimeId?: string
  ): VisibilityResumeMissing[] {
    return recordVisibilityResumeInventoryReceipt({
      batch: this.batch,
      omissions: this.options.omissions,
      environmentId,
      visibilityGeneration,
      inventoryReceivedFrame,
      snapshots,
      hostAuthoritative,
      runtimeId
    })
  }

  beginVisibilityResume(
    visibilityGeneration: number,
    restartingSpecIndexes: readonly number[]
  ): void {
    this.batch = buildVisibilityResumeBatch({
      visibilityGeneration,
      restartingSpecIndexes,
      environmentIdBySubscriptionSpec: this.options.environmentIdBySubscriptionSpec,
      environments: this.options.environments,
      omissions: this.options.omissions,
      activeRuntimeWorktreeKey: this.options.activeRuntimeWorktreeKey
    })
  }
}
