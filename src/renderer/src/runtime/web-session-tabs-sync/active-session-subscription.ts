import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { isRuntimeSubscriptionReplayResponse } from '../../../../shared/runtime-subscription-replay'
import { useAppStore } from '../../store'
import { mirroredRuntimeEnvironmentIdForWorkspace } from './mirrored-workspace-owner'
import { getRuntimeEnvironmentRevision } from '../runtime-environment-revision'
import { recoverWebSessionTerminalOrphansBeforeApply } from '../web-session-terminal-orphan-recovery'
import {
  installWindowVisibilitySubscriptionParking,
  type WindowVisibilitySubscriptionParking
} from '../window-visibility-subscription-parking'
import {
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './tracking'
import {
  decideWebSessionTabsSnapshot,
  shouldRespawnWebRuntimeTerminalAfterWake,
  shouldSyncRuntimeSessionTabs
} from './tracking-decisions'
import {
  acceptReplayedWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration
} from './tracking-lifecycle'
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
import {
  beginWebRuntimeWakeTerminalRespawn,
  endWebRuntimeWakeTerminalRespawn,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from '../web-runtime-wake-terminal-respawn'
import { createWebRuntimeSessionTerminal } from '../web-runtime-terminal-creation'
import { releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame } from '../web-runtime-initial-terminal-bootstrap'
import { createInitialTerminalSeeder } from './initial-terminal-seeder'
import { toRuntimeWorktreeSelector } from '../runtime-worktree-selector'
import { hostSnapshotAffirmsWorktreeContents } from '../host-session-snapshot-authority'
import { isSessionTabsStreamEnd, type SessionTabsStreamEvent } from './state'
import type { SessionTabsSnapshotHandler } from './visibility-resume-types'
import { subscribeRuntimeEnvironment } from '../runtime-environment-pairing-refresh'

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

/** Install one worktree's stream, which resumes immediately on visibility changes. */
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
  // Why: a warm stream keeps running after the user switches away; only the selected worktree on
  // this host may seed (one worktree id can exist on two hosts).
  const isSelected = (): boolean => {
    const state = useAppStore.getState()
    return (
      state.activeWorktreeId === activeWorktreeId &&
      mirroredRuntimeEnvironmentIdForWorkspace(state, activeWorktreeId) === environmentId
    )
  }
  const seeder = createInitialTerminalSeeder(environmentId, activeWorktreeId)
  let requestedRespawnAfterWake = false
  let hostAffirmedWorktree = false

  const applyActiveSnapshot = async (
    event: RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' },
    response: RuntimeRpcResponse<unknown>,
    isCurrent: () => boolean,
    receivedFrame: number,
    runtimeId?: string
  ): Promise<HostSessionMirrorSettle | null> => {
    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      useAppStore.getState(),
      event,
      environmentId,
      {
        expectedEnvironmentPairingRevision: activeWorktreeRuntimePairingRevision,
        getCurrentState: () => useAppStore.getState()
      }
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
    const localTerminalCount = localTabs.length
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
      localTerminalCount,
      hasLiveLocalPty,
      skipWakeRespawn: shouldSkipWebRuntimeWakeTerminalRespawn(activeWorktreeId)
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
        (state) => applyWebSessionTabsSnapshot(state, recovered, environmentId),
        {
          frames: [
            {
              environmentId,
              worktreeId: recovered.worktree,
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
      // Why here and only on an applied frame: this is the mirror's answer about the worktree. A
      // bootstrap whose create resolved without a row was parked until that answer arrived; a
      // pending create keeps its claim (see the latch module). The predicate above already ran with
      // the latch held, so this frame never seeds — the next one decides on real state.
      releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame(environmentId, recovered.worktree)
    }
    if (decision.apply && isCurrent()) {
      // Why: a warm stream may get its only empty answer while unselected; selection re-decides it.
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
              const frame = recordReceivedWebSessionTabsSnapshot(
                environmentId,
                event,
                undefined,
                runtimeId
              )
              visibilitySnapshotReceipt.current(environmentId, event, frame, runtimeId)
              void applyActiveSnapshot(event, response, isCurrent, frame, runtimeId)
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
