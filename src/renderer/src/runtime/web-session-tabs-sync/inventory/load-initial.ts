import {
  captureBrowserInitializationDelivery,
  recordBrowserInitializationReceipt
} from '../tab-projection/browser-initialization-presentation'
import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { useAppStore } from '../../../store/index'
import { getRuntimeEnvironmentRevision } from '../../rpc/environment-revisions/runtime-environment-revision'
import { recoverMirroredTerminalOrphansBeforeApply } from '../terminal-handles/mirror-terminal-orphan-recovery'
import {
  isSessionTabsListAllResult,
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from '../tracking/tracking'
import { decideWebSessionTabsSnapshot } from '../tracking/tracking-decisions'
import {
  acceptSessionTabsRuntimeId,
  getSessionTabsRuntimeIdFromResponse,
  recordReceivedWebSessionTabsEnvironmentFrame
} from '../tracking/publisher-identity-fences'
import {
  latestReceivedSessionTabsFrameByEnvironment,
  latestReceivedSessionTabsInventoryFrameByEnvironment,
  nextReceivedSessionTabsFrame
} from '../state'
import { applyWebSessionTabsSnapshots } from '../snapshots/snapshot-api'
import { applyWebSessionTabsStorePatch } from '../snapshots/store-patch'
import { applyReceivedAgentSenderPublications } from '../tracking/received-agent-sender-publications'
import { isHostMirroredWorktree } from '../identity/host-mirrored-worktree'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { copyWebClientChatReadMarksOnce } from '@/store/slices/agent-status/structured-sessions/chat-read-mark-web-copy'

export type InitialSessionTabsLoadArgs = {
  environmentId: string
  expectedEnvironmentConnectionGeneration: number
  expectedEnvironmentPairingRevision: number | undefined
  expectedTrackingGeneration: number
  isCurrent: () => boolean
}

export function loadInitialWebSessionTabs({
  environmentId,
  expectedEnvironmentConnectionGeneration,
  expectedEnvironmentPairingRevision,
  expectedTrackingGeneration,
  isCurrent
}: InitialSessionTabsLoadArgs): void {
  // Why: listAll is bootstrap fallback; a stream received after this boundary owns the result.
  const requestReceivedFrame = nextReceivedSessionTabsFrame()
  const delivery = captureBrowserInitializationDelivery(environmentId)
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
      for (const snapshot of result.snapshots) {
        recordBrowserInitializationReceipt(environmentId, snapshot, requestReceivedFrame, delivery)
      }
      const receivedFrames = result.snapshots.map((snapshot) =>
        recordReceivedWebSessionTabsSnapshot(
          environmentId,
          snapshot,
          requestReceivedFrame,
          runtimeId,
          'bootstrap'
        )
      )
      applyReceivedAgentSenderPublications(environmentId, result.snapshots, runtimeId)
      const recovered = await Promise.all(
        result.snapshots.map((snapshot) =>
          recoverMirroredTerminalOrphansBeforeApply(
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
      // Every chat the host lists, applied or not: the copy needs only their conversation ids.
      const chatSessionIds = result.snapshots.flatMap((snapshot) =>
        snapshot.tabs.flatMap((tab) => (tab.type === 'agent-session' ? [tab.sessionId] : []))
      )
      settleHydration = applyWebSessionTabsStorePatch(
        (state, changedAgentPaneKeys) => {
          const patch = applyWebSessionTabsSnapshots(
            state,
            freshSnapshots,
            environmentId,
            undefined,
            changedAgentPaneKeys
          )
          // In the same commit as the first tabs, so no chat shows before its marks.
          const copied = isWebClientLocation()
            ? copyWebClientChatReadMarksOnce(state, chatSessionIds)
            : null
          return copied ? { ...(patch === state ? {} : patch), ...copied } : patch
        },
        {
          frames: applicable.map((snapshot, index) => ({
            environmentId,
            worktreeId: snapshot.worktree,
            source: snapshot,
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
                  // Workspaces the mirror never writes contribute no evidence to the environment-wide verdict.
                  publishedSnapshotCount: result.snapshots.filter((snapshot) =>
                    isHostMirroredWorktree(snapshot.worktree)
                  ).length
                }
              }
            : {})
        },
        applicable
      )
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
