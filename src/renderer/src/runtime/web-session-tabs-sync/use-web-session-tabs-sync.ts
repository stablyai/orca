import { useEffect, useLayoutEffect, useRef } from 'react'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { useAppStore } from '../../store'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '../../lib/worktree-runtime-owner'
import { useRuntimeSessionMirrorEnvironmentKeys } from '../use-runtime-session-mirror-environment-key'
import { sessionTabsFreshnessKey } from './tracking'
import { clearWebSessionTabsTrackingForEnvironment } from './tracking-lifecycle'
import {
  installGlobalSessionTabsSubscriptions,
  type GlobalSubscriptionRefs
} from './global-session-subscription'
import { installActiveSessionTabsSubscription } from './active-session-subscription'

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

  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const workspaceSessionReady = useAppStore((state) => state.workspaceSessionReady)
  const { environmentKey: runtimeSessionMirrorEnvironmentKey, resubscribeSignal } =
    useRuntimeSessionMirrorEnvironmentKeys()
  const activeWorktreeRuntimeEnvironmentId = useAppStore((state) =>
    getExplicitRuntimeEnvironmentIdForWorktree(state, state.activeWorktreeId)
  )
  // Keep this subscription dependency: a runtime reconnect can retain the same environment id
  // while replacing its runtime instance, which must restart the scoped stream. Read the last
  // identity the host answered with, not `entry.status` — an unverifiable probe nulls that and
  // cold-rebuilt this stream for a host that was still delivering.
  const activeWorktreeRuntimeId = useAppStore((state) => {
    const environmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, state.activeWorktreeId)
    return environmentId
      ? (lastVerifiedRuntimeStatus(state.runtimeStatusByEnvironmentId.get(environmentId))
          ?.runtimeId ?? null)
      : null
  })
  const activeWorktreeRuntimeConnectionGeneration = useAppStore((state) => {
    const environmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, state.activeWorktreeId)
    return environmentId
      ? (state.runtimeStatusByEnvironmentId.get(environmentId)?.connectionGeneration ?? 0)
      : 0
  })
  // Restart trigger only, deliberately not passed to the installer: the scoped stream died with
  // the transport, but the frames it will resend still belong to the same connection generation.
  const activeWorktreeRuntimeHostContactEpoch = useAppStore((state) => {
    const environmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, state.activeWorktreeId)
    return environmentId
      ? (state.runtimeStatusByEnvironmentId.get(environmentId)?.hostContactEpoch ?? 0)
      : 0
  })
  const activeWorktreeRuntimePairingRevision = useAppStore((state) => {
    const environmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, state.activeWorktreeId)
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
    return installGlobalSessionTabsSubscriptions({
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
    // `resubscribeSignal` is a dependency and never an argument: a regained host needs its streams
    // reinstalled, but the mirror state they refill is stamped with the key, which has not moved.
  }, [runtimeSessionMirrorEnvironmentKey, resubscribeSignal, workspaceSessionReady])

  useEffect(() => {
    return installActiveSessionTabsSubscription({
      activeWorktreeId,
      activeWorktreeRuntimeEnvironmentId,
      activeWorktreeRuntimeConnectionGeneration,
      activeWorktreeRuntimePairingRevision,
      workspaceSessionReady,
      visibilitySnapshotReceipt: visibilitySnapshotReceiptRef,
      visibilitySnapshotApply: visibilitySnapshotApplyRef,
      visibilitySnapshotAccepted: visibilitySnapshotAcceptedRef
    })
  }, [
    activeWorktreeId,
    activeWorktreeRuntimeEnvironmentId,
    activeWorktreeRuntimeConnectionGeneration,
    activeWorktreeRuntimeHostContactEpoch,
    activeWorktreeRuntimePairingRevision,
    activeWorktreeRuntimeId,
    workspaceSessionReady
  ])
}
