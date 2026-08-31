import { canConnectSshStatus } from '@/ssh/ssh-connection-recoverability'
import type { DirectSshAuthority, SshConnectionState } from '../../../../shared/ssh-types'
import { useAppStore } from '../../store'
import { isDirectSshReconnectCoordinatorRoutingEnabled } from '../direct-ssh-reconnect-rollout'
import { directSshAuthoritiesEqual } from '../direct-ssh-reconnect-tokens'
import {
  registerDirectSshWakeRouting,
  routeDirectSshConnectedState,
  type DirectSshConnectedStateOrigin
} from '../direct-ssh-state-routing'
import type { DirectSshBridgeRuntime } from './direct-ssh-bridge-runtime'
import { hydrateDirectSshInitialState } from './direct-ssh-initial-state-hydration'
export function registerDirectSshStateIpcBridge(
  unsubs: (() => void)[],
  runtime: DirectSshBridgeRuntime
): void {
  const {
    reconnectAuthorityByTarget,
    reconnectCoordinator,
    currentAuthority,
    terminalActions,
    prepareAndSync
  } = runtime
  const sshStateWatermarkByTargetId = new Map<string, number>()
  const pendingPortHydrationByTargetId = new Map<
    string,
    { receivedForwardPush: boolean; receivedDetectedPush: boolean }
  >()
  const hydrateSshPorts = (targetId: string, authority: DirectSshAuthority): void => {
    const pendingPortHydration = {
      receivedForwardPush: false,
      receivedDetectedPush: false
    }
    pendingPortHydrationByTargetId.set(targetId, pendingPortHydration)
    const isHydrationAuthorityCurrent = (): boolean =>
      !runtime.isStopped() && directSshAuthoritiesEqual(currentAuthority(targetId), authority)
    const forwardHydration = window.api.ssh.listPortForwards({ targetId }).then((forwards) => {
      if (isHydrationAuthorityCurrent() && !pendingPortHydration.receivedForwardPush) {
        useAppStore.getState().setPortForwards(targetId, forwards)
      }
    })
    const detectedHydration = window.api.ssh.listDetectedPorts({ targetId }).then((detected) => {
      if (isHydrationAuthorityCurrent() && !pendingPortHydration.receivedDetectedPush) {
        useAppStore.getState().setDetectedPorts(targetId, detected)
      }
    })
    void Promise.allSettled([forwardHydration, detectedHydration]).then(() => {
      if (pendingPortHydrationByTargetId.get(targetId) === pendingPortHydration) {
        pendingPortHydrationByTargetId.delete(targetId)
      }
    })
  }
  let applySshConnectionStateChange!: (
    targetId: string,
    state: SshConnectionState,
    origin: DirectSshConnectedStateOrigin
  ) => void
  void hydrateDirectSshInitialState(runtime, sshStateWatermarkByTargetId, (targetId, state) =>
    applySshConnectionStateChange(targetId, state, 'initial-hydration')
  )
  unsubs.push(
    window.api.ssh.onCredentialRequest((data) => {
      useAppStore.getState().enqueueSshCredentialRequest(data)
    })
  )
  unsubs.push(
    window.api.ssh.onCredentialResolved(({ requestId }) => {
      useAppStore.getState().removeSshCredentialRequest(requestId)
    })
  )

  unsubs.push(
    window.api.ssh.onPortForwardsChanged(({ targetId, forwards }) => {
      const pendingPortHydration = pendingPortHydrationByTargetId.get(targetId)
      if (pendingPortHydration) {
        pendingPortHydration.receivedForwardPush = true
      }
      useAppStore.getState().setPortForwards(targetId, forwards)
    })
  )

  unsubs.push(
    window.api.ssh.onDetectedPortsChanged(({ targetId, ports }) => {
      const pendingPortHydration = pendingPortHydrationByTargetId.get(targetId)
      if (pendingPortHydration) {
        pendingPortHydration.receivedDetectedPush = true
      }
      useAppStore.getState().setDetectedPorts(targetId, ports)
    })
  )

  const reconcileSshAuthority = (
    targetId: string,
    initiatingState: SshConnectionState,
    origin: DirectSshConnectedStateOrigin,
    watermark: number
  ): void => {
    let pendingDeadline: { timer: ReturnType<typeof setTimeout>; settle: () => void } | undefined
    const deadline = new Promise<null>((resolve) => {
      const settle = (): void => resolve(null)
      const timer = setTimeout(settle, 5_000)
      pendingDeadline = { timer, settle }
      runtime.addDeadline(pendingDeadline)
    })
    void Promise.race([window.api.ssh.getState({ targetId }).catch(() => null), deadline])
      .then((latest) => {
        if (
          runtime.isStopped() ||
          latest?.targetId !== targetId ||
          !latest?.providerEpoch ||
          latest.connectionGeneration === undefined ||
          (sshStateWatermarkByTargetId.get(targetId) ?? 0) !== watermark
        ) {
          return
        }
        const current = useAppStore.getState().sshConnectionStates?.get(targetId)
        if (
          current?.status !== initiatingState.status ||
          latest.status !== initiatingState.status ||
          current.providerEpoch !== initiatingState.providerEpoch ||
          current.connectionGeneration !== initiatingState.connectionGeneration ||
          (current.providerEpoch !== undefined &&
            current.providerEpoch !== null &&
            current.providerEpoch !== latest.providerEpoch) ||
          (current.connectionGeneration !== undefined &&
            current.connectionGeneration !== latest.connectionGeneration)
        ) {
          return
        }
        applySshConnectionStateChange(
          targetId,
          {
            ...current,
            providerEpoch: latest.providerEpoch,
            connectionGeneration: latest.connectionGeneration
          },
          origin
        )
      })
      .catch(() => undefined)
      .finally(() => {
        if (pendingDeadline) {
          clearTimeout(pendingDeadline.timer)
          runtime.removeDeadline(pendingDeadline)
        }
      })
  }

  applySshConnectionStateChange = (
    targetId: string,
    state: SshConnectionState,
    origin: DirectSshConnectedStateOrigin
  ): void => {
    const store = useAppStore.getState()
    const previous = store.sshConnectionStates?.get(targetId)
    store.setSshConnectionState(targetId, state)

    if (canConnectSshStatus(state.status)) {
      reconnectAuthorityByTarget.delete(targetId)
      reconnectCoordinator.invalidate(targetId)
      store.clearRemoteDetectedAgents(targetId)

      store.clearPortForwards(targetId)
      store.setDetectedPorts(targetId, [])

      store.clearDirectSshTargetPtyBindings(targetId)
      return
    }

    if (state.status !== 'connected') {
      return
    }
    const authority = currentAuthority(targetId)
    if (!authority) {
      reconcileSshAuthority(targetId, state, origin, sshStateWatermarkByTargetId.get(targetId) ?? 0)
      return
    }
    const previousAuthority =
      previous?.status === 'connected' &&
      previous.providerEpoch &&
      previous.connectionGeneration !== undefined
        ? {
            targetId,
            providerEpoch: previous.providerEpoch,
            connectionGeneration: previous.connectionGeneration
          }
        : null
    routeDirectSshConnectedState(
      {
        coordinator: reconnectCoordinator,
        coordinatorRoutingEnabled: isDirectSshReconnectCoordinatorRoutingEnabled(),
        invalidateStaleTerminalBindings: (nextAuthority) =>
          terminalActions().invalidateStaleDirectSshTargetPtyBindings?.(nextAuthority) ?? 0,
        retryTargetPanes: (nextAuthority) =>
          terminalActions().retryDirectSshTargetPanes?.(nextAuthority) ?? 0,
        prepareAndSync: prepareAndSync,
        rememberReconnectAuthority: (nextAuthority) => {
          if (nextAuthority) {
            reconnectAuthorityByTarget.set(targetId, nextAuthority)
          } else {
            reconnectAuthorityByTarget.delete(targetId)
          }
        }
      },
      { authority, previousAuthority, origin }
    )
    if (origin === 'initial-hydration') {
      hydrateSshPorts(targetId, authority)
    }
  }

  let sshTargetStateEventId = 0
  const latestSshTargetStateEventByTargetId = new Map<string, number>()

  const handleSshStateChangedEvent = (data: { targetId: string; state: unknown }): void => {
    const store = useAppStore.getState()
    const state = data.state as SshConnectionState
    const stateEventId = ++sshTargetStateEventId
    sshStateWatermarkByTargetId.set(
      data.targetId,
      (sshStateWatermarkByTargetId.get(data.targetId) ?? 0) + 1
    )
    latestSshTargetStateEventByTargetId.set(data.targetId, stateEventId)
    if (!store.sshTargetLabels.has(data.targetId)) {
      window.api.ssh
        .listTargets()
        .catch(() => window.api.ssh.listTargets())
        .then((targets) => {
          if (latestSshTargetStateEventByTargetId.get(data.targetId) !== stateEventId) {
            return
          }
          latestSshTargetStateEventByTargetId.delete(data.targetId)
          if (runtime.isStopped()) {
            return
          }
          const latestStore = useAppStore.getState()
          if (!targets.some((target) => target.id === data.targetId)) {
            latestStore.clearRemovedSshTargetState(data.targetId)
            return
          }
          latestStore.setSshTargetsMetadata(targets)
          applySshConnectionStateChange(data.targetId, state, 'push')
        })
        .catch(() => {
          if (
            !runtime.isStopped() &&
            latestSshTargetStateEventByTargetId.get(data.targetId) === stateEventId
          ) {
            latestSshTargetStateEventByTargetId.delete(data.targetId)
            applySshConnectionStateChange(data.targetId, state, 'push')
          }
        })
      return
    }

    latestSshTargetStateEventByTargetId.delete(data.targetId)
    applySshConnectionStateChange(data.targetId, state, 'push')
  }

  unsubs.push(window.api.ssh.onStateChanged(handleSshStateChangedEvent))
  unsubs.push(
    registerDirectSshWakeRouting({
      getConnectionStates: () => useAppStore.getState().sshConnectionStates ?? [],
      wakeAuthority: (authority) => {
        reconnectCoordinator.correctUnboundTerminals(authority, 'wake-refresh')
        void prepareAndSync(authority, 'wake-refresh')
      },
      ...(typeof window.api.ui.onSystemResumed === 'function'
        ? { onSystemResumed: (callback: () => void) => window.api.ui.onSystemResumed(callback) }
        : {})
    })
  )
}
