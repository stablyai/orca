import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { useAppStore } from '../../store'
import { recoverWebSessionTerminalOrphansBeforeApply } from '../web-session-terminal-orphan-recovery'
import { queueAcceptedWebSessionTerminalSnapshot } from '../web-session-terminal-handle-events'
import {
  beginWebSessionTabsSnapshotRecovery,
  recordReceivedWebSessionTabsInventory,
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './tracking'
import {
  decideWebSessionTabsSnapshot,
  WEB_SESSION_TABS_FRAME_OUTRANKED
} from './tracking-decisions'
import { acceptReplayedWebSessionTabsSnapshot } from './tracking-lifecycle'
import { applyWebSessionTabsSnapshots } from './snapshot-api'
import {
  latestSessionTabsSnapshotByWorktree,
  replayableSessionTabsSnapshotByWorktree
} from './state'
import { applyWebSessionTabsStorePatch } from './store-patch'
import { isHostMirroredWorktree } from './visibility-types'
import type { VisibilityResumeCoordinator } from './visibility-resume-coordinator'

export type GlobalSessionInventoryEventArgs = {
  environmentId: string
  expectedEnvironmentConnectionGeneration: number
  expectedEnvironmentPairingRevision?: number
  expectedTrackingGeneration: number
  visibilityGeneration: number
  isCurrent: () => boolean
  event: { type: 'snapshots'; snapshots: RuntimeMobileSessionTabsResult[]; authoritative?: boolean }
  replayed: boolean
  runtimeId?: string
  awaitingVisibilityResumeInventory: { value: boolean }
  coordinator: VisibilityResumeCoordinator
}

/** Apply a full-inventory frame from the all-worktrees stream, fencing visibility omissions. */
export function handleGlobalSessionInventoryEvent({
  environmentId,
  expectedEnvironmentConnectionGeneration,
  expectedEnvironmentPairingRevision,
  expectedTrackingGeneration,
  visibilityGeneration,
  isCurrent,
  event,
  replayed,
  runtimeId,
  awaitingVisibilityResumeInventory,
  coordinator
}: GlobalSessionInventoryEventArgs): void {
  const skipUnchangedResumeWork = awaitingVisibilityResumeInventory.value && !replayed
  awaitingVisibilityResumeInventory.value = false
  const unchanged = event.snapshots.map((snapshot) => {
    const key = `${environmentId}:${snapshot.worktree}`
    const freshness = latestSessionTabsSnapshotByWorktree.get(key)
    return Boolean(
      skipUnchangedResumeWork &&
      !replayableSessionTabsSnapshotByWorktree.has(key) &&
      freshness?.publicationEpoch === snapshot.publicationEpoch &&
      freshness.snapshotVersion === snapshot.snapshotVersion
    )
  })
  const receivedFrames = event.snapshots.map((snapshot) => {
    const frame = recordReceivedWebSessionTabsSnapshot(
      environmentId,
      snapshot,
      undefined,
      runtimeId
    )
    coordinator.recordSnapshotReceipt(environmentId, snapshot, frame, runtimeId)
    return frame
  })
  const inventoryFrame = recordReceivedWebSessionTabsInventory(environmentId)
  const missing = coordinator.recordInventoryReceipt(
    environmentId,
    visibilityGeneration,
    inventoryFrame,
    event.snapshots,
    event.authoritative === true,
    runtimeId
  )
  const finishRecoveries = event.snapshots.map((snapshot, index) =>
    unchanged[index]
      ? null
      : beginWebSessionTabsSnapshotRecovery(
          environmentId,
          snapshot.worktree,
          receivedFrames[index]!
        )
  )
  let settleHydration: (() => void) | null = null
  void Promise.all(
    event.snapshots.map((snapshot, index) =>
      unchanged[index]
        ? Promise.resolve(snapshot)
        : recoverWebSessionTerminalOrphansBeforeApply(
            useAppStore.getState(),
            snapshot,
            environmentId,
            {
              expectedEnvironmentPairingRevision,
              getCurrentState: () => useAppStore.getState()
            }
          )
    )
  )
    .then((recovered) => {
      if (!isCurrent()) {
        return
      }
      const applicable = recovered.flatMap((snapshot, index) =>
        snapshot !== null &&
        shouldApplyRecoveredWebSessionTabsSnapshot(
          environmentId,
          snapshot,
          receivedFrames[index]!,
          runtimeId
        ) &&
        coordinator.shouldApplySnapshot(environmentId, snapshot, receivedFrames[index]!, runtimeId)
          ? [{ index, snapshot }]
          : []
      )
      if (visibilityGeneration > 0 || replayed) {
        for (const { index, snapshot } of applicable) {
          if (!unchanged[index]) {
            acceptReplayedWebSessionTabsSnapshot(environmentId, snapshot.worktree)
          }
        }
      }
      const decisions = applicable.map(({ index, snapshot }) =>
        unchanged[index]
          ? WEB_SESSION_TABS_FRAME_OUTRANKED
          : decideWebSessionTabsSnapshot(snapshot, environmentId, runtimeId)
      )
      const freshSnapshots = applicable.flatMap(({ snapshot }, index) =>
        decisions[index]!.apply ? [snapshot] : []
      )
      settleHydration = applyWebSessionTabsStorePatch(
        (state) => applyWebSessionTabsSnapshots(state, freshSnapshots, environmentId),
        {
          frames: applicable.map(({ snapshot }, index) => ({
            environmentId,
            worktreeId: snapshot.worktree,
            decision: decisions[index]!,
            expectedEnvironmentConnectionGeneration,
            expectedEnvironmentPairingRevision,
            expectedTrackingGeneration
          })),
          fullInventory: {
            environmentId,
            authoritative: event.authoritative === true,
            expectedEnvironmentConnectionGeneration,
            expectedEnvironmentPairingRevision,
            expectedTrackingGeneration,
            publishedSnapshotCount: event.snapshots.filter((snapshot) =>
              isHostMirroredWorktree(snapshot.worktree)
            ).length
          }
        },
        freshSnapshots
      )
      const freshSet = new Set(freshSnapshots)
      for (const { index, snapshot } of applicable) {
        if (unchanged[index]) {
          queueAcceptedWebSessionTerminalSnapshot(snapshot, environmentId)
        }
        if (unchanged[index] || freshSet.has(snapshot)) {
          coordinator.recordSnapshot(environmentId, snapshot, receivedFrames[index]!, runtimeId)
        }
      }
      coordinator.recordInventory(environmentId, visibilityGeneration, inventoryFrame, missing)
    })
    .catch((error) => {
      if (isCurrent()) {
        console.warn('[web-session-tabs-sync] snapshot recovery failed:', error)
      }
    })
    .finally(() => {
      for (const finishRecovery of finishRecoveries) {
        finishRecovery?.()
      }
      if (isCurrent()) {
        settleHydration?.()
      }
    })
}
