import { createDirectSshReconnectProductTelemetryAdapter } from '@/lib/direct-ssh-reconnect-product-telemetry'
import { acquireDirectSshDetectedWorktreeRefresh } from '@/store/slices/worktrees'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type { DirectSshAuthority } from '../../../../shared/ssh-types'
import { useAppStore } from '../../store'
import {
  createDirectSshHostHydration,
  type DirectSshHostHydration
} from '../direct-ssh-host-hydration'
import {
  createDirectSshReconnectCoordinator,
  type DirectSshPreparationInput,
  type DirectSshPreparationReason,
  type DirectSshReconnectCoordinator
} from '../direct-ssh-reconnect-coordinator'
import { directSshAuthoritiesEqual } from '../direct-ssh-reconnect-tokens'
import { createDirectSshWorktreeRefreshScheduler } from '../direct-ssh-worktree-refresh-scheduler'
import {
  createRemoteWorkspaceTargetSync,
  type RemoteWorkspaceTargetSync
} from '../remote-workspace-target-sync'
import type { AppState } from '../../store/types'

type DirectSshTerminalActions = Partial<
  Pick<AppState, 'invalidateStaleDirectSshTargetPtyBindings' | 'retryDirectSshTargetPanes'>
>
type AuthorityDeadline = { timer: ReturnType<typeof setTimeout>; settle: () => void }

export type DirectSshBridgeRuntime = {
  reconnectAuthorityByTarget: Map<string, DirectSshAuthority>
  reconnectCoordinator: DirectSshReconnectCoordinator
  hostHydration: DirectSshHostHydration
  remoteWorkspaceTargetSync: RemoteWorkspaceTargetSync | null
  currentAuthority: (targetId: string) => DirectSshAuthority | null
  terminalActions: () => DirectSshTerminalActions
  prepareAndSync: (
    authority: DirectSshAuthority,
    reason: DirectSshPreparationReason,
    options?: { authorityAlreadyReplaced?: boolean }
  ) => Promise<void>
  isStopped: () => boolean
  addDeadline: (deadline: AuthorityDeadline) => void
  removeDeadline: (deadline: AuthorityDeadline) => void
  stop: () => void
}

export function createDirectSshBridgeRuntime(): DirectSshBridgeRuntime {
  const reconnectAuthorityByTarget = new Map<string, DirectSshAuthority>()
  const deadlines = new Set<AuthorityDeadline>()
  let stopped = false
  const currentAuthority = (targetId: string): DirectSshAuthority | null => {
    const state = useAppStore.getState().sshConnectionStates?.get(targetId)
    if (
      state?.status !== 'connected' ||
      state.targetId !== targetId ||
      !state.providerEpoch ||
      state.connectionGeneration === undefined
    ) {
      return null
    }
    return {
      targetId,
      providerEpoch: state.providerEpoch,
      connectionGeneration: state.connectionGeneration
    }
  }
  const scheduler = createDirectSshWorktreeRefreshScheduler({
    startAttempt: (key) => {
      const acquired = acquireDirectSshDetectedWorktreeRefresh(useAppStore, {
        repoId: key.repoId,
        executionHostId: key.executionHostId,
        authority: {
          targetId: key.targetId,
          providerEpoch: key.providerEpoch,
          connectionGeneration: key.connectionGeneration
        },
        requireAuthoritative: key.authorityRequirement === 'required'
      })
      return {
        providerRequestId: acquired.providerRequestId,
        result: acquired.result.then((result) => acquired.merge(result)),
        cancel: acquired.release
      }
    }
  })
  const hostHydration = createDirectSshHostHydration({
    store: useAppStore,
    isCurrentAuthority: (authority) =>
      directSshAuthoritiesEqual(currentAuthority(authority.targetId), authority),
    listRepos: (authority) => {
      const executionHostId = toSshExecutionHostId(authority.targetId)
      return (
        window.api.repos.listForExecutionHost?.({
          executionHostId,
          expectedAuthority: authority
        }) ??
        Promise.resolve({ authoritative: false, executionHostId, reason: 'unavailable' as const })
      )
    },
    listLineage: (authority) => {
      const executionHostId = toSshExecutionHostId(authority.targetId)
      return (
        window.api.worktrees.listLineageForHost?.({
          executionHostId,
          expectedAuthority: authority
        }) ??
        Promise.resolve({ authoritative: false, executionHostId, reason: 'unavailable' as const })
      )
    }
  })
  const terminalActions = (): DirectSshTerminalActions =>
    useAppStore.getState() as DirectSshTerminalActions
  let remoteWorkspaceTargetSync: RemoteWorkspaceTargetSync | null = null
  const reconnectCoordinator = createDirectSshReconnectCoordinator({
    scheduler,
    isCurrentConnectedAuthority: (authority) =>
      directSshAuthoritiesEqual(currentAuthority(authority.targetId), authority),
    capturePreparationInput: hostHydration.capturePreparationInput,
    readHostScopedLineage: hostHydration.readHostScopedLineage,
    invalidateStaleTerminalBindings: (authority) =>
      terminalActions().invalidateStaleDirectSshTargetPtyBindings?.(authority) ?? 0,
    retryTargetPanes: (authority) => terminalActions().retryDirectSshTargetPanes?.(authority) ?? 0,
    finalizeHydratedTerminalPanes: (authority) =>
      terminalActions().retryDirectSshTargetPanes?.(authority) ?? 0,
    correctUnboundTerminalPanes: (authority) =>
      terminalActions().retryDirectSshTargetPanes?.(authority) ?? 0,
    syncRemoteWorkspaceAfterConnect: (token) => remoteWorkspaceTargetSync?.syncAfterConnect(token),
    onTelemetry: createDirectSshReconnectProductTelemetryAdapter()
  })
  const remoteWorkspaceApi = window.api.remoteWorkspace
  if (remoteWorkspaceApi) {
    remoteWorkspaceTargetSync = createRemoteWorkspaceTargetSync({
      store: useAppStore,
      remoteWorkspace: remoteWorkspaceApi,
      getCurrentAuthority: currentAuthority,
      isPreparationTokenCurrent: hostHydration.isPreparationTokenCurrent,
      capturePreparationInput: (authority, reason, revision) =>
        hostHydration.capturePreparationInput(authority, reason, revision),
      prepareOnly: reconnectCoordinator.prepareOnly,
      finalizeHydratedTerminals: (authority) =>
        directSshAuthoritiesEqual(reconnectAuthorityByTarget.get(authority.targetId), authority)
          ? reconnectCoordinator.finalizeHydratedTerminals(authority)
          : 0
    })
  }
  const prepareAndSync: DirectSshBridgeRuntime['prepareAndSync'] = async (
    authority,
    reason,
    options
  ) => {
    try {
      if (!options?.authorityAlreadyReplaced) {
        reconnectCoordinator.replaceAuthority(authority)
      }
      const input: DirectSshPreparationInput | null = await hostHydration.capturePreparationInput(
        authority,
        reason
      )
      if (!input) {
        return
      }
      const prepared = await reconnectCoordinator.prepareOnly(input)
      if (prepared.token && hostHydration.isPreparationTokenCurrent(prepared.token)) {
        await remoteWorkspaceTargetSync?.syncAfterConnect(prepared.token)
      }
    } catch (error) {
      if (directSshAuthoritiesEqual(currentAuthority(authority.targetId), authority)) {
        useAppStore.getState().setRemoteWorkspaceSyncStatus(authority.targetId, {
          phase: 'error',
          message: error instanceof Error ? error.message : 'Workspace sync failed'
        })
      }
    }
  }
  return {
    reconnectAuthorityByTarget,
    reconnectCoordinator,
    hostHydration,
    remoteWorkspaceTargetSync,
    currentAuthority,
    terminalActions,
    prepareAndSync,
    isStopped: () => stopped,
    addDeadline: (deadline) => deadlines.add(deadline),
    removeDeadline: (deadline) => deadlines.delete(deadline),
    stop: () => {
      stopped = true
      for (const deadline of deadlines) {
        clearTimeout(deadline.timer)
        deadline.settle()
      }
      deadlines.clear()
      remoteWorkspaceTargetSync?.stop()
      hostHydration.stop()
      reconnectCoordinator.stop()
      reconnectAuthorityByTarget.clear()
    }
  }
}
