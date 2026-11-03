import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { useFloatingWorkspaceHost } from '@/lib/floating-workspace-host'
import { installActiveSessionTabsSubscription } from '@/runtime/web-session-tabs-sync/active-session-subscription'
import { projectFloatingSessionSnapshot } from '@/runtime/floating-session-snapshot'
import { floatingWorkspaceId } from '../../../../shared/floating-workspace-id'
import { translate } from '@/i18n/i18n'

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
      setState({
        environmentId,
        loading: false,
        error: translate('remoteFloatingTerminal.unpaired', 'Host is no longer paired.')
      })
      return
    }
    const worktreeId = floatingWorkspaceId(environmentId)
    const fail = (error: unknown) =>
      setState({
        environmentId,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      })
    return installActiveSessionTabsSubscription({
      activeWorktreeId: worktreeId,
      activeWorktreeRuntimeEnvironmentId: environmentId,
      activeWorktreeRuntimeConnectionGeneration: connectionGeneration,
      activeWorktreeRuntimePairingRevision: pairingRevision,
      workspaceSessionReady: true,
      projectSnapshot: (snapshot) => projectFloatingSessionSnapshot(snapshot, environmentId),
      onError: fail,
      visibilitySnapshotReceipt: { current: () => {} },
      visibilitySnapshotApply: { current: () => true },
      visibilitySnapshotAccepted: {
        current: () => setState({ environmentId, loading: false, error: null })
      }
    })
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
