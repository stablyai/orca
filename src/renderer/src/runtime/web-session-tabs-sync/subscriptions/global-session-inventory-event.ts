import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { recheckUnconfirmedStructuredAgentLaunches } from '../../../lib/agent-session/launch/structured-agent-session-launch-unconfirmed-recheck'
import { useAppStore } from '../../../store/index'
import { recoverMirroredTerminalOrphansBeforeApply } from '../terminal-handles/mirror-terminal-orphan-recovery'
import { queueAcceptedWebSessionTerminalSnapshot } from '../terminal-handles/web-session-terminal-handle-events'
import {
  recordReceivedWebSessionTabsInventory,
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from '../tracking/tracking'
import {
  decideWebSessionTabsSnapshot,
  WEB_SESSION_TABS_FRAME_OUTRANKED
} from '../tracking/tracking-decisions'
import {
  acceptReplayedWebSessionTabsSnapshot,
  latestReceivedSessionTabsSnapshotByWorktree,
  latestSessionTabsSnapshotByWorktree,
  replayableSessionTabsSnapshotByWorktree
} from '../state'
import { applyReceivedAgentSenderPublications } from '../tracking/received-agent-sender-publications'
import { applyWebSessionTabsSnapshots } from '../snapshots/snapshot-api'

import { applyWebSessionTabsStorePatch } from '../snapshots/store-patch'
import { isHostMirroredWorktree } from '../identity/host-mirrored-worktree'
import { hostSnapshotAffirmsAgentSessions } from '../../../../../shared/remote-runtime/session-graph/host-session-snapshot-authority'
import type { VisibilityResumeCoordinator } from '../visibility-resume/visibility-resume-coordinator'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'

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
  applyReceivedAgentSenderPublications(environmentId, event.snapshots, runtimeId)
  // After receipt: a held close dropped at receipt marks its unchanged frame for redraw.
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
  const inventoryFrame = recordReceivedWebSessionTabsInventory(environmentId)
  const missing = coordinator.recordInventoryReceipt(
    environmentId,
    visibilityGeneration,
    inventoryFrame,
    event.snapshots,
    event.authoritative === true,
    runtimeId
  )
  let settleHydration: (() => void) | null = null
  void Promise.all(
    event.snapshots.map((snapshot, index) =>
      unchanged[index]
        ? Promise.resolve(snapshot)
        : recoverMirroredTerminalOrphansBeforeApply(
            useAppStore.getState(),
            snapshot,
            environmentId,
            {
              expectedEnvironmentPairingRevision,
              expectedRuntimeId: runtimeId,
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
      const migrateChatReadMarks =
        isWebClientLocation() && !useAppStore.getState().chatReadMarksCopiedHere
      const settledWorkspaces = migrateChatReadMarks
        ? new Set(
            applicable.flatMap(({ snapshot }, index) =>
              decisions[index]!.settlesHostMirror ? [snapshot.worktree] : []
            )
          )
        : undefined
      const pendingAgentSessionWorkspaceIds = migrateChatReadMarks
        ? event.snapshots.flatMap((snapshot, index) => {
            if (!isHostMirroredWorktree(snapshot.worktree)) {
              return []
            }
            const key = `${environmentId}:${snapshot.worktree}`
            const received = latestReceivedSessionTabsSnapshotByWorktree.get(key)
            const applied = latestSessionTabsSnapshotByWorktree.get(key)
            if (received && received.receivedFrame !== receivedFrames[index]) {
              return !applied ||
                applied.publicationEpoch !== received.publicationEpoch ||
                applied.snapshotVersion !== received.snapshotVersion
                ? [snapshot.worktree]
                : []
            }
            if (!hostSnapshotAffirmsAgentSessions(snapshot)) {
              return [snapshot.worktree]
            }
            return settledWorkspaces?.has(snapshot.worktree) ? [] : [snapshot.worktree]
          })
        : undefined
      settleHydration = applyWebSessionTabsStorePatch(
        (state, changedAgentPaneKeys) =>
          applyWebSessionTabsSnapshots(
            state,
            freshSnapshots,
            environmentId,
            undefined,
            changedAgentPaneKeys
          ),
        {
          frames: applicable.map(({ snapshot }, index) => ({
            environmentId,
            worktreeId: snapshot.worktree,
            source: snapshot,
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
            ).length,
            mirroredWorkspaceIds: migrateChatReadMarks
              ? event.snapshots
                  .filter((snapshot) => isHostMirroredWorktree(snapshot.worktree))
                  .map((snapshot) => snapshot.worktree)
              : undefined,
            affirmedAgentSessionWorkspaceIds: migrateChatReadMarks
              ? event.snapshots
                  .filter(
                    (snapshot) =>
                      isHostMirroredWorktree(snapshot.worktree) &&
                      hostSnapshotAffirmsAgentSessions(snapshot)
                  )
                  .map((snapshot) => snapshot.worktree)
              : undefined,
            pendingAgentSessionWorkspaceIds
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
      if (isCurrent()) {
        settleHydration?.()
      }
    })
  // Each subscription opens with one census: recheck launches now that the host is reachable.
  recheckUnconfirmedStructuredAgentLaunches(toRuntimeExecutionHostId(environmentId))
}
