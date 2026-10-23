import { canConnectSshStatus } from '@/ssh/ssh-connection-recoverability'
import type { DirectSshAuthority, SshConnectionState } from '../../../../shared/ssh-types'
import { useAppStore } from '../../store'
import { directSshAuthoritiesEqual } from '../../store/slices/worktrees/listing/direct-ssh-authority'
import {
  directSshAuthorityFromConnectionState,
  type DirectSshConnectedStateOrigin
} from '../direct-ssh-state-routing'
import { hydrateDirectSshInitialState } from './direct-ssh-initial-state-hydration'
import { syncSshConfigTargetsPassively } from '../../lib/ssh-config-passive-sync'
import { applySshManagedServerTransition } from './ssh-managed-server-state-effects'

type AuthorityDeadline = { timer: ReturnType<typeof setTimeout>; settle: () => void }

/** Returns the stop that settles pending authority reads; listeners are released through unsubs. */
export function registerDirectSshStateIpcBridge(unsubs: (() => void)[]): () => void {
  let stopped = false
  const isStopped = (): boolean => stopped
  const deadlines = new Set<AuthorityDeadline>()
  const currentAuthority = (targetId: string): DirectSshAuthority | null => {
    const state = useAppStore.getState().sshConnectionStates?.get(targetId)
    return state ? directSshAuthorityFromConnectionState(targetId, state) : null
  }
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
      !isStopped() && directSshAuthoritiesEqual(currentAuthority(targetId), authority)
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
  void hydrateDirectSshInitialState(isStopped, sshStateWatermarkByTargetId, (targetId, state) =>
    applySshConnectionStateChange(targetId, state, 'initial-hydration')
  ).then(() => {
    // Why: after the saved list paints, so a slow config parse never delays the first host list.
    if (!isStopped()) {
      void syncSshConfigTargetsPassively()
    }
  })
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
    let pendingDeadline: AuthorityDeadline | undefined
    const deadline = new Promise<null>((resolve) => {
      const settle = (): void => resolve(null)
      const timer = setTimeout(settle, 5_000)
      pendingDeadline = { timer, settle }
      deadlines.add(pendingDeadline)
    })
    void Promise.race([window.api.ssh.getState({ targetId }).catch(() => null), deadline])
      .then((latest) => {
        if (
          isStopped() ||
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
          deadlines.delete(pendingDeadline)
        }
      })
  }

  applySshConnectionStateChange = (
    targetId: string,
    state: SshConnectionState,
    origin: DirectSshConnectedStateOrigin
  ): void => {
    const store = useAppStore.getState()
    const previousManagedServer = store.sshConnectionStates.get(targetId)?.managedServer
    store.setSshConnectionState(targetId, state)
    applySshManagedServerTransition(targetId, previousManagedServer, state.managedServer)

    if (canConnectSshStatus(state.status)) {
      store.clearRemoteDetectedAgents(targetId)

      store.clearPortForwards(targetId)
      store.setDetectedPorts(targetId, [])
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
          if (isStopped()) {
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
            !isStopped() &&
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
  return () => {
    stopped = true
    for (const deadline of deadlines) {
      clearTimeout(deadline.timer)
      deadline.settle()
    }
    deadlines.clear()
  }
}
