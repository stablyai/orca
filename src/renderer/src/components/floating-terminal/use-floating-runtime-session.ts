import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { useFloatingWorkspaceHost } from '@/lib/floating-workspace-host'
import { installWindowVisibilitySubscriptionParking } from '@/runtime/window-visibility-subscription-parking'
import { projectFloatingSessionSnapshot } from '@/runtime/floating-session-snapshot'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { floatingWorkspaceId } from '../../../../shared/floating-workspace-id'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { recordReceivedWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/tracking'
import { getSessionTabsRuntimeIdFromResponse } from '@/runtime/web-session-tabs-sync/publisher-identity-fences'
import {
  acceptReplayedWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration
} from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import { decideWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/tracking-decisions'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import { applyWebSessionTabsStorePatch } from '@/runtime/web-session-tabs-sync/store-patch'

type SessionState = { environmentId: string | null; loading: boolean; error: string | null }

export function useFloatingRuntimeSession(open: boolean) {
  const environmentId = useFloatingWorkspaceHost((state) => state.environmentId)
  const environment = useAppStore((state) =>
    state.runtimeEnvironments?.find((host) => host.id === environmentId)
  )
  const contactEpoch = useAppStore((state) =>
    environmentId
      ? state.runtimeStatusByEnvironmentId?.get(environmentId)?.hostContactEpoch
      : undefined
  )
  const connectionGeneration = useAppStore((state) =>
    environmentId
      ? (state.runtimeStatusByEnvironmentId?.get(environmentId)?.connectionGeneration ?? 0)
      : 0
  )
  const pairingRevision = environment
    ? (environment.pairingRevision ?? environment.createdAt)
    : undefined
  const [state, setState] = useState<SessionState>({
    environmentId: null,
    loading: false,
    error: null
  })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!environmentId || !open) {
      return
    }
    setState({ environmentId, loading: true, error: null })
    if (!environment) {
      setState({ environmentId, loading: false, error: 'Host is no longer paired.' })
      return
    }
    const worktreeId = floatingWorkspaceId(environmentId)
    const trackingGeneration = getWebSessionTabsTrackingGeneration(environmentId)
    const fail = (error: unknown) =>
      setState({
        environmentId,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      })
    return installWindowVisibilitySubscriptionParking([
      {
        subscribe: (isCurrent) =>
          window.api.runtimeEnvironments.subscribe(
            {
              selector: environmentId,
              method: 'session.tabs.subscribe',
              params: { worktree: toRuntimeWorktreeSelector(worktreeId) },
              timeoutMs: 15_000,
              expectedEnvironmentPairingRevision: pairingRevision
            },
            {
              onResponse: (response) => {
                if (
                  !isCurrent() ||
                  getRuntimeEnvironmentRevision(environmentId) !== pairingRevision
                ) {
                  return
                }
                if (!response.ok) {
                  fail(response.error.message)
                  return
                }
                const raw = response.result
                if (
                  !raw ||
                  typeof raw !== 'object' ||
                  !('type' in raw) ||
                  (raw.type !== 'snapshot' && raw.type !== 'updated') ||
                  !('tabs' in raw) ||
                  !Array.isArray(raw.tabs) ||
                  !('worktree' in raw) ||
                  typeof raw.worktree !== 'string' ||
                  !('publicationEpoch' in raw) ||
                  typeof raw.publicationEpoch !== 'string' ||
                  !('snapshotVersion' in raw) ||
                  typeof raw.snapshotVersion !== 'number' ||
                  !('activeGroupId' in raw) ||
                  !('activeTabId' in raw) ||
                  !('activeTabType' in raw)
                ) {
                  return
                }
                const snapshot = projectFloatingSessionSnapshot(
                  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: session.tabs.subscribe returns the host's typed session snapshot; event kind and tab array were checked above.
                  raw as RuntimeMobileSessionTabsResult,
                  environmentId
                )
                if (snapshot.worktree !== worktreeId) {
                  return
                }
                const runtimeId = getSessionTabsRuntimeIdFromResponse(response)
                recordReceivedWebSessionTabsSnapshot(environmentId, snapshot, undefined, runtimeId)
                if (raw.type === 'snapshot') {
                  acceptReplayedWebSessionTabsSnapshot(environmentId, worktreeId)
                }
                const decision = decideWebSessionTabsSnapshot(snapshot, environmentId, runtimeId)
                const settle = applyWebSessionTabsStorePatch(
                  (current) =>
                    decision.apply
                      ? applyWebSessionTabsSnapshot(current, snapshot, environmentId)
                      : current,
                  {
                    frames: [
                      {
                        environmentId,
                        worktreeId,
                        decision,
                        expectedEnvironmentConnectionGeneration: connectionGeneration,
                        expectedEnvironmentPairingRevision: pairingRevision,
                        expectedTrackingGeneration: trackingGeneration
                      }
                    ]
                  },
                  snapshot
                )
                settle()
                setState({ environmentId, loading: false, error: null })
              },
              onError: (error) => {
                if (isCurrent()) {
                  fail(error)
                }
              }
            }
          ),
        onSubscribeError: fail
      }
    ])
  }, [
    environmentId,
    environment,
    open,
    pairingRevision,
    connectionGeneration,
    contactEpoch,
    revision
  ])
  return {
    loading: environmentId !== null && (state.environmentId !== environmentId || state.loading),
    error: state.environmentId === environmentId ? state.error : null,
    retry: () => setRevision((value) => value + 1)
  }
}
