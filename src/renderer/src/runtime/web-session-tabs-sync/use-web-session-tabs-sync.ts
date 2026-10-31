import { useEffect, useLayoutEffect, useRef } from 'react'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { useAppStore } from '../../store'
import { useRuntimeSessionMirrorEnvironmentKeys } from '../use-runtime-session-mirror-environment-key'
import { sessionTabsFreshnessKey } from './tracking'
import { clearWebSessionTabsTrackingForEnvironment } from './tracking-lifecycle'
import {
  installGlobalSessionTabsSubscriptions,
  type GlobalSubscriptionRefs
} from './global-session-subscription'
import { installActiveSessionTabsSubscription } from './active-session-subscription'
import { mirroredRuntimeEnvironmentIdForWorkspace } from './mirrored-workspace-owner'
import {
  createWarmWorktreeSessionSubscriptions,
  type WarmWorktreeSessionSubscriptions
} from './warm-worktree-subscriptions'

/** Mount the paired-runtime tab mirrors and the selected-worktree stream. */
export function useWebSessionTabsSync(): void {
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
  const activeWorktreeRuntimeId = useAppStore((state) => {
    const environmentId = mirroredRuntimeEnvironmentIdForWorkspace(state, state.activeWorktreeId)
    return environmentId
      ? (lastVerifiedRuntimeStatus(state.runtimeStatusByEnvironmentId.get(environmentId))
          ?.runtimeId ?? null)
      : null
  })
  const activeWorktreeRuntimeConnectionGeneration = useAppStore((state) => {
    const environmentId = mirroredRuntimeEnvironmentIdForWorkspace(state, state.activeWorktreeId)
    return environmentId
      ? (state.runtimeStatusByEnvironmentId.get(environmentId)?.connectionGeneration ?? 0)
      : 0
  })
  // Reconnect trigger only, not stream identity: outage-ended streams resend frames for the same connection.
  const activeWorktreeRuntimeHostContactEpoch = useAppStore((state) => {
    const environmentId = mirroredRuntimeEnvironmentIdForWorkspace(state, state.activeWorktreeId)
    return environmentId
      ? (state.runtimeStatusByEnvironmentId.get(environmentId)?.hostContactEpoch ?? 0)
      : 0
  })
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
