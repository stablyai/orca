import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  lastVerifiedRuntimeStatus,
  type RuntimeEnvironmentStatus
} from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { useRuntimeHostStatusSelector } from '../../store/slices/runtime-status/views/use-runtime-status-view'
import { useAppStore } from '../../store'
import { useRemoteOrchestrationSync } from '../agent-orchestration/remote-orchestration-sync'
import { useRuntimeSessionMirrorEnvironmentKeys } from './subscriptions/use-runtime-session-mirror-environment-key'
import { sessionTabsFreshnessKey } from './state'
import { clearWebSessionTabsTrackingForEnvironment } from './tracking/tracking-lifecycle'
import {
  installGlobalSessionTabsSubscriptions,
  type GlobalSubscriptionRefs
} from './subscriptions/global-session-subscription'
import { installActiveSessionTabsSubscription } from './subscriptions/active-session-subscription'
import { mirroredRuntimeEnvironmentIdForWorkspace } from './workspace-selection/mirrored-workspace-owner'
import {
  createWarmWorktreeSessionSubscriptions,
  type WarmWorktreeSessionSubscriptions
} from './subscriptions/warm-worktree-subscriptions'

/** Mount the paired-runtime tab mirrors and the selected-worktree stream. */
type RuntimeStatusEntry = RuntimeEnvironmentStatus | undefined
const selectVerifiedRuntimeId = (entry: RuntimeStatusEntry): string | null =>
  lastVerifiedRuntimeStatus(entry)?.runtimeId ?? null
const selectConnectionGeneration = (entry: RuntimeStatusEntry): number =>
  entry?.connectionGeneration ?? 0
const selectHostContactEpoch = (entry: RuntimeStatusEntry): number => entry?.hostContactEpoch ?? 0

export function useWebSessionTabsSync(): void {
  useRemoteOrchestrationSync()
  const activeRuntimeEnvironmentIdRef = useRef<string | null>(null)
  const activeRuntimeWorktreeKeyRef = useRef<string | null>(null)
  const visibilityResumeOmissionsRef = useRef<
    GlobalSubscriptionRefs['visibilityResumeOmissions']['current']
  >(new Map())
  const ownerRevisionsRef = useRef<GlobalSubscriptionRefs['ownerRevisions']['current']>(new Map())
  const visibilitySnapshotReceiptRef = useRef<GlobalSubscriptionRefs['snapshotReceipt']['current']>(
    () => {}
  )
  const visibilitySnapshotApplyRef = useRef<GlobalSubscriptionRefs['snapshotApply']['current']>(
    () => true
  )
  const visibilitySnapshotAcceptedRef = useRef<
    GlobalSubscriptionRefs['snapshotAccepted']['current']
  >(() => {})
  const globalSubscriptionsRef = useRef<ReturnType<
    typeof installGlobalSessionTabsSubscriptions
  > | null>(null)
  const worktreeSubscriptionsRef = useRef<WarmWorktreeSessionSubscriptions | null>(null)

  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const workspaceSessionReady = useAppStore((state) => state.workspaceSessionReady)
  const { environmentKey: runtimeSessionMirrorEnvironmentKey, resubscribeSignal } =
    useRuntimeSessionMirrorEnvironmentKeys()
  const activeWorktreeRuntimeEnvironmentId = useAppStore((state) =>
    mirroredRuntimeEnvironmentIdForWorkspace(state, state.activeWorktreeId)
  )
  // Reconnect may replace runtime under the same environment ID; restart scoped streams from last answered identity. Probe-unverifiable status is null even while delivery continues.
  const activeWorktreeRuntimeId = useRuntimeHostStatusSelector(
    activeWorktreeRuntimeEnvironmentId || null,
    selectVerifiedRuntimeId
  )
  const activeWorktreeRuntimeConnectionGeneration = useRuntimeHostStatusSelector(
    activeWorktreeRuntimeEnvironmentId || null,
    selectConnectionGeneration
  )
  // Reconnect trigger only, not stream identity: outage-ended streams resend frames for the same connection.
  const activeWorktreeRuntimeHostContactEpoch = useRuntimeHostStatusSelector(
    activeWorktreeRuntimeEnvironmentId || null,
    selectHostContactEpoch
  )
  const activeWorktreeRuntimePairingRevision = useAppStore((state) => {
    const environmentId = mirroredRuntimeEnvironmentIdForWorkspace(state, state.activeWorktreeId)
    const environment = state.runtimeEnvironments.find(
      (candidate) => candidate.id === environmentId
    )
    return environment ? (environment.pairingRevision ?? environment.createdAt) : undefined
  })

  useLayoutEffect(() => {
    const environmentId = activeWorktreeRuntimeEnvironmentId?.trim() || null
    activeRuntimeEnvironmentIdRef.current = environmentId
    activeRuntimeWorktreeKeyRef.current =
      environmentId && activeWorktreeId
        ? sessionTabsFreshnessKey(environmentId, activeWorktreeId)
        : null
  }, [activeWorktreeId, activeWorktreeRuntimeEnvironmentId])

  useEffect(
    () => () => {
      for (const environmentId of ownerRevisionsRef.current.keys()) {
        clearWebSessionTabsTrackingForEnvironment(environmentId)
      }
      ownerRevisionsRef.current.clear()
      visibilityResumeOmissionsRef.current.clear()
    },
    []
  )

  useEffect(() => {
    const subscriptions = installGlobalSessionTabsSubscriptions({
      runtimeSessionMirrorEnvironmentKey,
      workspaceSessionReady,
      refs: {
        activeRuntimeEnvironmentId: activeRuntimeEnvironmentIdRef,
        activeRuntimeWorktreeKey: activeRuntimeWorktreeKeyRef,
        visibilityResumeOmissions: visibilityResumeOmissionsRef,
        snapshotReceipt: visibilitySnapshotReceiptRef,
        snapshotApply: visibilitySnapshotApplyRef,
        snapshotAccepted: visibilitySnapshotAcceptedRef,
        ownerRevisions: ownerRevisionsRef
      }
    })
    globalSubscriptionsRef.current = subscriptions ?? null
    return () => {
      globalSubscriptionsRef.current = null
      subscriptions?.()
    }
  }, [runtimeSessionMirrorEnvironmentKey, workspaceSessionReady])

  // Regained contact revives only dead streams; stable mirror keys retain state, and probe flaps without outages must not resubscribe.
  useEffect(() => {
    globalSubscriptionsRef.current?.restartEnded()
  }, [resubscribeSignal])

  useEffect(() => {
    const subscriptions = createWarmWorktreeSessionSubscriptions(
      installActiveSessionTabsSubscription
    )
    worktreeSubscriptionsRef.current = subscriptions
    return () => {
      worktreeSubscriptionsRef.current = null
      subscriptions.dispose()
    }
  }, [])

  useEffect(() => {
    worktreeSubscriptionsRef.current?.select(
      {
        activeWorktreeId,
        activeWorktreeRuntimeEnvironmentId,
        activeWorktreeRuntimeConnectionGeneration,
        activeWorktreeRuntimePairingRevision,
        workspaceSessionReady,
        visibilitySnapshotReceipt: visibilitySnapshotReceiptRef,
        visibilitySnapshotApply: visibilitySnapshotApplyRef,
        visibilitySnapshotAccepted: visibilitySnapshotAcceptedRef
      },
      activeWorktreeRuntimeId
    )
  }, [
    activeWorktreeId,
    activeWorktreeRuntimeEnvironmentId,
    activeWorktreeRuntimeConnectionGeneration,
    activeWorktreeRuntimePairingRevision,
    activeWorktreeRuntimeId,
    workspaceSessionReady
  ])

  useEffect(() => {
    const environmentId = activeWorktreeRuntimeEnvironmentId?.trim()
    if (environmentId) {
      worktreeSubscriptionsRef.current?.restartEnded(environmentId)
    }
  }, [activeWorktreeRuntimeEnvironmentId, activeWorktreeRuntimeHostContactEpoch])
}
