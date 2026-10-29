import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import {
  runtimeHostConnectionStateForEntry,
  type RuntimeHostConnectionState
} from '@/runtime/runtime-host-connection-state'
import { createPairedRuntimeParkingEnvironmentIdsSelector } from '@/components/terminal-pane/paired-runtime-parking-capabilities'

type RuntimeStatusState = {
  runtimeStatusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
}
type RuntimeStatusStore = {
  getState: () => RuntimeStatusState
  subscribe: (listener: () => void) => () => void
}
type Listener = () => void
type ConnectionSubscription = {
  snapshot: RuntimeHostConnectionState
  listeners: Set<Listener>
}

export function createRuntimeStatusSubscriptions(store: RuntimeStatusStore) {
  const connections = new Map<string, ConnectionSubscription>()
  const parkingListeners = new Set<Listener>()
  let selectParking = createPairedRuntimeParkingEnvironmentIdsSelector()
  let parkingSnapshot: ReadonlySet<string> | null = null
  let previousStatuses: RuntimeStatusState['runtimeStatusByEnvironmentId'] | null = null
  let unsubscribeStore: (() => void) | null = null

  function getConnectionSnapshot(environmentId: string | null): RuntimeHostConnectionState {
    return runtimeHostConnectionStateForEntry(
      environmentId === null
        ? undefined
        : store.getState().runtimeStatusByEnvironmentId.get(environmentId)
    )
  }

  function getParkingSnapshot(): ReadonlySet<string> {
    return selectParking(store.getState().runtimeStatusByEnvironmentId)
  }

  function ensureSubscription(): void {
    if (unsubscribeStore) {
      return
    }
    previousStatuses = store.getState().runtimeStatusByEnvironmentId
    unsubscribeStore = store.subscribe(() => {
      const statuses = store.getState().runtimeStatusByEnvironmentId
      const previous = previousStatuses
      if (statuses === previous) {
        return
      }
      previousStatuses = statuses
      const pending: { listeners: Set<Listener>; listener: Listener }[] = []
      for (const [environmentId, subscription] of connections) {
        if (statuses.get(environmentId) === previous?.get(environmentId)) {
          continue
        }
        const snapshot = runtimeHostConnectionStateForEntry(statuses.get(environmentId))
        if (snapshot === subscription.snapshot) {
          continue
        }
        subscription.snapshot = snapshot
        for (const listener of subscription.listeners) {
          pending.push({ listeners: subscription.listeners, listener })
        }
      }
      if (parkingListeners.size > 0) {
        const snapshot = getParkingSnapshot()
        if (snapshot !== parkingSnapshot) {
          parkingSnapshot = snapshot
          for (const listener of parkingListeners) {
            pending.push({ listeners: parkingListeners, listener })
          }
        }
      }
      // Establish every comparison baseline before callbacks can commit nested writes.
      for (const { listeners, listener } of pending) {
        if (listeners.has(listener)) {
          listener()
        }
      }
    })
  }

  function releaseIfUnused(): void {
    if (connections.size > 0 || parkingListeners.size > 0) {
      return
    }
    unsubscribeStore?.()
    unsubscribeStore = null
    previousStatuses = null
    parkingSnapshot = null
    selectParking = createPairedRuntimeParkingEnvironmentIdsSelector()
  }

  function subscribeConnection(environmentId: string | null, listener: Listener): () => void {
    if (environmentId === null) {
      return () => {}
    }
    ensureSubscription()
    let subscription = connections.get(environmentId)
    if (!subscription) {
      subscription = { snapshot: getConnectionSnapshot(environmentId), listeners: new Set() }
      connections.set(environmentId, subscription)
    }
    const registered = () => listener()
    subscription.listeners.add(registered)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      subscription.listeners.delete(registered)
      if (subscription.listeners.size === 0) {
        connections.delete(environmentId)
      }
      releaseIfUnused()
    }
  }

  function subscribeParking(listener: Listener): () => void {
    ensureSubscription()
    if (parkingListeners.size === 0) {
      parkingSnapshot = getParkingSnapshot()
    }
    const registered = () => listener()
    parkingListeners.add(registered)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      parkingListeners.delete(registered)
      releaseIfUnused()
    }
  }

  return { getConnectionSnapshot, subscribeConnection, getParkingSnapshot, subscribeParking }
}
