import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { isRuntimeSubscriptionReplayResponse } from '../../../../../shared/remote-runtime/rpc/runtime-subscription-replay'
import { useAppStore } from '../../../store/index'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/workspace-layout/layout-owner-switch'
import { isFrameDrawnServerWorkspace } from '../frame-drawn/frame-drawn-server-workspace-set'
import { isActiveSessionSubscriptionSelected } from './active-session-subscription-selection'
import { getRuntimeEnvironmentRevision } from '../../rpc/environment-revisions/runtime-environment-revision'
import { recoverMirroredTerminalOrphansBeforeApply } from '../terminal-handles/mirror-terminal-orphan-recovery'
import type { TerminalOrphanRecoveryOptions } from '../../hosted-terminals/recovery/web-session-terminal-orphan-recovery-options'
import {
  installWindowVisibilitySubscriptionParking,
  type WindowVisibilitySubscriptionParking
} from '../../rpc/subscriptions/window-visibility-subscription-parking'
import { shouldApplyRecoveredWebSessionTabsSnapshot } from '../tracking/tracking'
import {
  decideWebSessionTabsSnapshot,
  shouldRespawnWebRuntimeTerminalAfterWake,
  shouldSyncRuntimeSessionTabs
} from '../tracking/tracking-decisions'
import {
  acceptReplayedWebSessionTabsSnapshot,
  isSessionTabsStreamEnd,
  type SessionTabsStreamEvent
} from '../state'
import { getWebSessionTabsTrackingGeneration } from '../tracking/tracking-lifecycle'
import {
  acceptSessionTabsRuntimeId,
  getSessionTabsRuntimeIdFromResponse
} from '../tracking/publisher-identity-fences'
import { recordReceivedSessionTabsStreamFrame } from '../tracking/received-agent-sender-publications'
import { createWebSessionTabsSnapshotPatch } from '../snapshots/snapshot-api'
import { applyWebSessionTabsStorePatch } from '../snapshots/store-patch'
import {
  hostSessionMirrorSettleForPatchlessFrame,
  type HostSessionMirrorSettle
} from '../hydration/mirror-settle'
import {
  beginWebRuntimeWakeTerminalRespawn,
  endWebRuntimeWakeTerminalRespawn,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from '../../hosted-terminals/restoration/web-runtime-wake-terminal-respawn'
import { createWebRuntimeSessionTerminal } from '../../hosted-terminals/creation/web-runtime-terminal-creation'
import { releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame } from '../initial-terminal/web-runtime-initial-terminal-bootstrap'
import { createInitialTerminalSeeder } from '../initial-terminal/initial-terminal-seeder'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import { hostSnapshotAffirmsWorktreeContents } from '../../../../../shared/remote-runtime/session-graph/host-session-snapshot-authority'

import type { SessionTabsSnapshotHandler } from '../visibility-resume/visibility-resume-types'
import { subscribeRuntimeEnvironment } from '../../rpc/environment-revisions/runtime-environment-pairing-refresh'

type Ref<T> = { current: T }

export type ActiveSubscriptionArgs = {
  activeWorktreeId: string | null
  activeWorktreeRuntimeEnvironmentId: string | null | undefined
  activeWorktreeRuntimeConnectionGeneration: number
  activeWorktreeRuntimePairingRevision: number | undefined
  workspaceSessionReady: boolean
  visibilitySnapshotReceipt: Ref<SessionTabsSnapshotHandler<void>>
  visibilitySnapshotApply: Ref<SessionTabsSnapshotHandler<boolean>>
  visibilitySnapshotAccepted: Ref<SessionTabsSnapshotHandler<void>>
}

export type ActiveSessionTabsSubscription = WindowVisibilitySubscriptionParking & {
  /** The worktree became selected again while its stream stayed warm. */
  reconsiderSelected: () => void
}

export function installActiveSessionTabsSubscription({
  activeWorktreeId,
  activeWorktreeRuntimeEnvironmentId,
  activeWorktreeRuntimeConnectionGeneration,
  activeWorktreeRuntimePairingRevision,
  workspaceSessionReady,
  visibilitySnapshotReceipt,
  visibilitySnapshotApply,
  visibilitySnapshotAccepted
}: ActiveSubscriptionArgs): ActiveSessionTabsSubscription | undefined {
  const environmentId = activeWorktreeRuntimeEnvironmentId?.trim()
  if (
    !shouldSyncRuntimeSessionTabs({
      activeWorktreeId,
      activeWorktreeRuntimeEnvironmentId,
      workspaceSessionReady
    }) ||
    !environmentId ||
    !activeWorktreeId
  ) {
    return undefined
  }
  const expectedTrackingGeneration = getWebSessionTabsTrackingGeneration(environmentId)
  const isSelected = (): boolean =>
    isActiveSessionSubscriptionSelected(environmentId, activeWorktreeId)
  const seeder = createInitialTerminalSeeder(environmentId, activeWorktreeId)
  let requestedRespawnAfterWake = false
  let hostAffirmedWorktree = false

  const applySnapshot = async (
    event: RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' },
    response: RuntimeRpcResponse<unknown>,
    isCurrent: () => boolean,
    receivedFrame: number,
    recoveryOptions: TerminalOrphanRecoveryOptions,
    runtimeId?: string
  ): Promise<HostSessionMirrorSettle | null> => {
    const recovered = await recoverMirroredTerminalOrphansBeforeApply(
      useAppStore.getState(),
      event,
      environmentId,
      recoveryOptions
    )
    if (
      !isCurrent() ||
      !recovered ||
      !shouldApplyRecoveredWebSessionTabsSnapshot(
        environmentId,
        recovered,
        receivedFrame,
        runtimeId
      ) ||
      !visibilitySnapshotApply.current(environmentId, recovered, receivedFrame, runtimeId)
    ) {
      return null
    }
    if (event.type === 'snapshot' || isRuntimeSubscriptionReplayResponse(response)) {
      acceptReplayedWebSessionTabsSnapshot(environmentId, recovered.worktree)
    }
    const recoveredEvent: SessionTabsStreamEvent = { ...recovered, type: event.type }
    const decision = decideWebSessionTabsSnapshot(recovered, environmentId, runtimeId)
    const syncState = useAppStore.getState()
    const localTabs = syncState.tabsByWorktree[activeWorktreeId] ?? []
    const hasLiveLocalPty = localTabs.some(
      (tab) => (syncState.ptyIdsByTabId[tab.id] ?? []).length > 0
    )
    const firstHostAnswer = !hostAffirmedWorktree
    const bootstrap = decision.apply && seeder.decide(recoveredEvent, firstHostAnswer)
    const respawn = shouldRespawnWebRuntimeTerminalAfterWake({
      event: recoveredEvent,
      activeWorktreeId,
      requestedRespawnAfterWake,
      snapshotIsFresh: decision.apply,
      localTerminalCount: localTabs.length,
      hasLiveLocalPty,
      skipWakeRespawn:
        shouldSkipWebRuntimeWakeTerminalRespawn(activeWorktreeId) ||
        // Switch point: ORCA_LAYOUT_OWNER_IS_MAIN && — a frame-drawn workspace's terminals are not the mirror's to respawn.
        // Interim (ledger L240): respawn stays only for servers without `layout.intents.v1`, until Phase 2.
        (ORCA_LAYOUT_OWNER_IS_MAIN && isFrameDrawnServerWorkspace(environmentId, activeWorktreeId))
    })
    let settle: HostSessionMirrorSettle | null = decision.apply
      ? null
      : hostSessionMirrorSettleForPatchlessFrame(decision, environmentId, recovered.worktree, {
          connectionGeneration: activeWorktreeRuntimeConnectionGeneration,
          pairingRevision: activeWorktreeRuntimePairingRevision,
          trackingGeneration: expectedTrackingGeneration
        })
    if (decision.apply) {
      hostAffirmedWorktree ||= hostSnapshotAffirmsWorktreeContents(recovered)
      const replayed = isRuntimeSubscriptionReplayResponse(response)
      settle = applyWebSessionTabsStorePatch(
        createWebSessionTabsSnapshotPatch(recovered, environmentId),
        {
          frames: [
            {
              environmentId,
              worktreeId: recovered.worktree,
              source: recovered,
              decision,
              expectedEnvironmentConnectionGeneration: activeWorktreeRuntimeConnectionGeneration,
              expectedEnvironmentPairingRevision: activeWorktreeRuntimePairingRevision,
              expectedTrackingGeneration
            }
          ]
        },
        recovered,
        event.type === 'updated' && !replayed
      )
      visibilitySnapshotAccepted.current(environmentId, recovered, receivedFrame, runtimeId)
      // Applied frames release awaiting-mirror only after seeding checked the held latch; pending RPCs retain claims and later frames decide retries.
      releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame(environmentId, recovered.worktree)
    }
    if (decision.apply && isCurrent()) {
      // Warm streams may answer empty only while unselected; redecide on selection.
      seeder.noteAppliedFrame(
        bootstrap ? { event: recoveredEvent, firstHostAnswer, receivedFrame, runtimeId } : null,
        isSelected()
      )
    }
    try {
      if (isCurrent() && isSelected() && bootstrap) {
        await seeder.seed()
      } else if (
        isCurrent() &&
        isSelected() &&
        respawn &&
        beginWebRuntimeWakeTerminalRespawn(activeWorktreeId)
      ) {
        requestedRespawnAfterWake = true
        await createWebRuntimeSessionTerminal({
          worktreeId: activeWorktreeId,
          environmentId,
          activate: true,
          selectWorktree: false
        }).finally(() => endWebRuntimeWakeTerminalRespawn(activeWorktreeId))
      }
    } catch (error) {
      if (isCurrent()) {
        console.warn('[web-session-tabs-sync] snapshot follow-up failed:', error)
      }
    }
    return settle
  }

  const parking = installWindowVisibilitySubscriptionParking([
    {
      subscribe: (isCurrent, { ended }) =>
        subscribeRuntimeEnvironment(
          {
            selector: environmentId,
            method: 'session.tabs.subscribe',
            params: { worktree: toRuntimeWorktreeSelector(activeWorktreeId) },
            timeoutMs: 15_000,
            expectedEnvironmentPairingRevision: activeWorktreeRuntimePairingRevision
          },
          {
            onResponse: (response) => {
              if (
                !isCurrent() ||
                getRuntimeEnvironmentRevision(environmentId) !==
                  activeWorktreeRuntimePairingRevision
              ) {
                return
              }
              if (response.ok === false) {
                console.warn('[web-session-tabs-sync] subscription failed:', response.error.message)
                ended()
                return
              }
              if (isSessionTabsStreamEnd(response.result)) {
                ended()
                return
              }
              const event = response.result as SessionTabsStreamEvent
              if (event.type !== 'snapshot' && event.type !== 'updated') {
                return
              }
              const runtimeId = getSessionTabsRuntimeIdFromResponse(response)
              if (runtimeId && !acceptSessionTabsRuntimeId(environmentId, runtimeId)) {
                return
              }
              const recoveryOptions = {
                expectedEnvironmentPairingRevision: activeWorktreeRuntimePairingRevision,
                getCurrentState: () => useAppStore.getState()
              }
              const frame = recordReceivedSessionTabsStreamFrame(
                environmentId,
                event,
                runtimeId,
                recoveryOptions
              )
              visibilitySnapshotReceipt.current(environmentId, event, frame, runtimeId)
              void applySnapshot(event, response, isCurrent, frame, recoveryOptions, runtimeId)
                .catch((error) => {
                  if (isCurrent()) {
                    console.warn('[web-session-tabs-sync] active snapshot recovery failed:', error)
                  }
                  return null
                })
                .then((settle) => {
                  if (isCurrent()) {
                    settle?.()
                  }
                })
            },
            onError: (error) => {
              if (isCurrent()) {
                console.warn('[web-session-tabs-sync] subscription error:', error.message)
              }
            },
            onClose: () => {
              if (isCurrent()) {
                ended()
              }
            }
          }
        ),
      onSubscribeError: (error) => {
        console.warn(
          '[web-session-tabs-sync] failed to subscribe:',
          error instanceof Error ? error.message : String(error)
        )
      },
      onUnsubscribeError: (error) => {
        console.warn('[web-session-tabs-sync] failed to unsubscribe:', error)
      }
    }
  ])
  return Object.assign(
    () => {
      seeder.dispose()
      parking()
    },
    {
      restartEnded: () => parking.restartEnded(),
      reconsiderSelected: () => seeder.reconsiderSelected(isSelected())
    }
  )
}
