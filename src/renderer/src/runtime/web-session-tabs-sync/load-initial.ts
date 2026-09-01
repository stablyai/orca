import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { useAppStore } from '../../store'
import { getRuntimeEnvironmentRevision } from '../runtime-environment-revision'
import { recoverWebSessionTerminalOrphansBeforeApply } from '../web-session-terminal-orphan-recovery'
import {
  beginWebSessionTabsSnapshotRecovery,
  isSessionTabsListAllResult,
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './tracking'
import { decideWebSessionTabsSnapshot } from './tracking-decisions'
import {
  acceptSessionTabsRuntimeId,
  getSessionTabsRuntimeIdFromResponse,
  recordReceivedWebSessionTabsEnvironmentFrame
} from './publisher-identity-fences'
import {
  latestReceivedSessionTabsFrameByEnvironment,
  latestReceivedSessionTabsInventoryFrameByEnvironment,
  nextReceivedSessionTabsFrame
} from './state'
import { applyWebSessionTabsSnapshots } from './snapshot-api'
import { applyWebSessionTabsStorePatch } from './store-patch'
import { isHostMirroredWorktree } from './visibility-types'

export type InitialSessionTabsLoadArgs = {
  environmentId: string
  expectedEnvironmentConnectionGeneration: number
  expectedEnvironmentPairingRevision: number | undefined
  expectedTrackingGeneration: number
  isCurrent: () => boolean
}

/** Perform the one-shot inventory fetch used to seed the mirror deterministically. */
export function loadInitialWebSessionTabs({
  environmentId,
  expectedEnvironmentConnectionGeneration,
  expectedEnvironmentPairingRevision,
  expectedTrackingGeneration,
  isCurrent
}: InitialSessionTabsLoadArgs): void {
  // Why: listAll is bootstrap fallback; a stream received after this boundary owns the result.
  const requestReceivedFrame = nextReceivedSessionTabsFrame()
  let settleHydration: (() => void) | null = null
  void window.api.runtimeEnvironments
    .call({
      selector: environmentId,
      method: 'session.tabs.listAll',
      params: {},
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision
    })
    .then(async (response: RuntimeRpcResponse<unknown>) => {
      if (
        !isCurrent() ||
        getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision
      ) {
        return
      }
      if (response.ok === false) {
        console.warn('[web-session-tabs-sync] initial listAll failed:', response.error.message)
        return
      }
      const result = response.result
      if (!isSessionTabsListAllResult(result)) {
        console.warn('[web-session-tabs-sync] initial listAll returned an invalid payload')
        return
      }
      const runtimeId = getSessionTabsRuntimeIdFromResponse(response)
      const latestReceivedFrame =
        latestReceivedSessionTabsFrameByEnvironment.get(environmentId) ?? 0
      if (
        runtimeId &&
        latestReceivedFrame <= requestReceivedFrame &&
        !acceptSessionTabsRuntimeId(environmentId, runtimeId, requestReceivedFrame)
      ) {
        return
      }
      recordReceivedWebSessionTabsEnvironmentFrame(environmentId, requestReceivedFrame)
      const receivedFrames = result.snapshots.map((snapshot) =>
        recordReceivedWebSessionTabsSnapshot(
          environmentId,
          snapshot,
          requestReceivedFrame,
          runtimeId,
          'bootstrap'
        )
      )
      const finishRecoveries = result.snapshots.map((snapshot, index) =>
        beginWebSessionTabsSnapshotRecovery(
          environmentId,
          snapshot.worktree,
          receivedFrames[index]!
        )
      )
      try {
        const recovered = await Promise.all(
          result.snapshots.map((snapshot) =>
            recoverWebSessionTerminalOrphansBeforeApply(
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
        if (
          !isCurrent() ||
          getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision
        ) {
          return
        }
        const initialInventorySuperseded =
          (latestReceivedSessionTabsInventoryFrameByEnvironment.get(environmentId) ?? 0) >
          requestReceivedFrame
        const applicable = recovered.filter(
          (snapshot, index): snapshot is RuntimeMobileSessionTabsResult =>
            snapshot !== null &&
            !initialInventorySuperseded &&
            shouldApplyRecoveredWebSessionTabsSnapshot(
              environmentId,
              snapshot,
              receivedFrames[index]!,
              runtimeId
            )
        )
        const decisions = applicable.map((snapshot) =>
          decideWebSessionTabsSnapshot(snapshot, environmentId, runtimeId)
        )
        const freshSnapshots = applicable.filter((_snapshot, index) => decisions[index]!.apply)
        const initialInventoryStillCurrent =
          latestReceivedSessionTabsFrameByEnvironment.get(environmentId) === requestReceivedFrame &&
          (latestReceivedSessionTabsInventoryFrameByEnvironment.get(environmentId) ?? 0) <=
            requestReceivedFrame
        settleHydration = applyWebSessionTabsStorePatch(
          (state) => applyWebSessionTabsSnapshots(state, freshSnapshots, environmentId),
          {
            frames: applicable.map((snapshot, index) => ({
              environmentId,
              worktreeId: snapshot.worktree,
              decision: decisions[index]!,
              expectedEnvironmentConnectionGeneration,
              expectedEnvironmentPairingRevision,
              expectedTrackingGeneration
            })),
            ...(initialInventoryStillCurrent
              ? {
                  fullInventory: {
                    environmentId,
                    authoritative: result.authoritative === true,
                    expectedEnvironmentConnectionGeneration,
                    expectedEnvironmentPairingRevision,
                    expectedTrackingGeneration,
                    // Why: a workspace the mirror never writes is not part of the
                    // inventory the environment-wide verdict has to account for.
                    publishedSnapshotCount: result.snapshots.filter((snapshot) =>
                      isHostMirroredWorktree(snapshot.worktree)
                    ).length
                  }
                }
              : {})
          },
          applicable
        )
      } finally {
        for (const finishRecovery of finishRecoveries) {
          finishRecovery()
        }
      }
    })
    .catch((error) => {
      if (isCurrent()) {
        console.warn(
          '[web-session-tabs-sync] failed to load initial session tabs:',
          error instanceof Error ? error.message : String(error)
        )
      }
    })
    .finally(() => {
      if (
        isCurrent() &&
        getRuntimeEnvironmentRevision(environmentId) === expectedEnvironmentPairingRevision
      ) {
        settleHydration?.()
      }
    })
}
