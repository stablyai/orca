import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { isRuntimeSubscriptionReplayResponse } from '../../../../shared/runtime-subscription-replay'
import { useAppStore } from '../../store'
import { recoverWebSessionTerminalOrphansBeforeApply } from '../web-session-terminal-orphan-recovery'
import {
  beginWebSessionTabsSnapshotRecovery,
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './tracking'
import { decideWebSessionTabsSnapshot } from './tracking-decisions'
import { acceptReplayedWebSessionTabsSnapshot } from './tracking-lifecycle'
import {
  acceptSessionTabsRuntimeId,
  getSessionTabsRuntimeIdFromResponse
} from './publisher-identity-fences'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import { applyWebSessionTabsStorePatch } from './store-patch'
import {
  hostSessionMirrorSettleForPatchlessFrame,
  type HostSessionMirrorSettle
} from './mirror-settle'
import { handleGlobalSessionInventoryEvent } from './global-session-inventory-event'
import type { VisibilityResumeCoordinator } from './visibility-resume-coordinator'

export type GlobalSessionEventArgs = {
  environmentId: string
  expectedEnvironmentConnectionGeneration: number
  expectedEnvironmentPairingRevision?: number
  expectedTrackingGeneration: number
  visibilityGeneration: number
  isCurrent: () => boolean
  event: unknown
  response: RuntimeRpcResponse<unknown>
  awaitingVisibilityResumeInventory: { value: boolean }
  coordinator: VisibilityResumeCoordinator
}

/** Apply one event from the all-worktrees stream, including visibility inventory fencing. */
export function handleGlobalSessionEvent(args: GlobalSessionEventArgs): void {
  const {
    environmentId,
    expectedEnvironmentConnectionGeneration,
    expectedEnvironmentPairingRevision,
    expectedTrackingGeneration,
    visibilityGeneration,
    isCurrent,
    response,
    awaitingVisibilityResumeInventory,
    coordinator
  } = args
  if (!isCurrent()) {
    return
  }
  if (response.ok === false) {
    console.warn('[web-session-tabs-sync] global subscription failed:', response.error.message)
    return
  }
  const runtimeId = getSessionTabsRuntimeIdFromResponse(response)
  if (runtimeId && !acceptSessionTabsRuntimeId(environmentId, runtimeId)) {
    return
  }
  const event = args.event as
    | (RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' })
    | { type: 'snapshots'; snapshots: RuntimeMobileSessionTabsResult[]; authoritative?: boolean }
    | { type: 'end' }
  const replayed = isRuntimeSubscriptionReplayResponse(response)
  if (event.type === 'snapshots') {
    handleGlobalSessionInventoryEvent({
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
    })
    return
  }
  if (event.type !== 'snapshot' && event.type !== 'updated') {
    return
  }
  const receivedFrame = recordReceivedWebSessionTabsSnapshot(
    environmentId,
    event,
    undefined,
    runtimeId
  )
  coordinator.recordSnapshotReceipt(environmentId, event, receivedFrame, runtimeId)
  const finishRecovery = beginWebSessionTabsSnapshotRecovery(
    environmentId,
    event.worktree,
    receivedFrame
  )
  let settleHydration: HostSessionMirrorSettle | null = null
  void recoverWebSessionTerminalOrphansBeforeApply(useAppStore.getState(), event, environmentId, {
    expectedEnvironmentPairingRevision,
    getCurrentState: () => useAppStore.getState()
  })
    .then((recovered) => {
      if (
        !isCurrent() ||
        !recovered ||
        !shouldApplyRecoveredWebSessionTabsSnapshot(
          environmentId,
          recovered,
          receivedFrame,
          runtimeId
        ) ||
        !coordinator.shouldApplySnapshot(environmentId, recovered, receivedFrame, runtimeId)
      ) {
        return
      }
      if (replayed) {
        acceptReplayedWebSessionTabsSnapshot(environmentId, recovered.worktree)
      }
      const decision = decideWebSessionTabsSnapshot(recovered, environmentId, runtimeId)
      if (decision.apply) {
        settleHydration = applyWebSessionTabsStorePatch(
          (state) => applyWebSessionTabsSnapshot(state, recovered, environmentId),
          {
            frames: [
              {
                environmentId,
                worktreeId: recovered.worktree,
                decision,
                expectedEnvironmentConnectionGeneration,
                expectedEnvironmentPairingRevision,
                expectedTrackingGeneration
              }
            ]
          },
          recovered,
          event.type === 'updated' && !replayed
        )
        coordinator.recordSnapshot(environmentId, recovered, receivedFrame, runtimeId)
      } else {
        settleHydration = hostSessionMirrorSettleForPatchlessFrame(
          decision,
          environmentId,
          recovered.worktree,
          {
            connectionGeneration: expectedEnvironmentConnectionGeneration,
            pairingRevision: expectedEnvironmentPairingRevision,
            trackingGeneration: expectedTrackingGeneration
          }
        )
      }
    })
    .catch((error) => {
      if (isCurrent()) {
        console.warn('[web-session-tabs-sync] snapshot recovery failed:', error)
      }
    })
    .finally(() => {
      finishRecovery()
      if (isCurrent()) {
        settleHydration?.()
      }
    })
}
