import type { RuntimeEnvironmentStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import type { RuntimeHostConnectionState } from '../../../../../../shared/remote-runtime/host-status/runtime-host-connection-state'
import { createPairedRuntimeParkingEnvironmentIdsSelector } from '@/components/terminal-pane/parking/retention/paired-runtime-parking-capabilities'

export type RuntimeStatuses = ReadonlyMap<string, RuntimeEnvironmentStatus>
type RuntimeStatusState = {
  runtimeStatusByEnvironmentId: RuntimeStatuses
}
export type RuntimeStatusStore = {
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
  const entryListeners = new Map<string, Set<Listener>>()
  const statusesListeners = new Set<Listener>()
  const parkingListeners = new Set<Listener>()
  let selectParking = createPairedRuntimeParkingEnvironmentIdsSelector()
  let parkingSnapshot: ReadonlySet<string> | null = null
  let previousStatuses: RuntimeStatuses | null = null
  let unsubscribeStore: (() => void) | null = null

  function readStatuses(): RuntimeStatuses {
    return store.getState().runtimeStatusByEnvironmentId
  }

  function getConnectionSnapshot(environmentId: string | null): RuntimeHostConnectionState {
    return runtimeHostConnectionStateForEntry(
      environmentId === null ? undefined : readStatuses().get(environmentId)
    )
  }

  function getParkingSnapshot(): ReadonlySet<string> {
    return selectParking(readStatuses())
  }

  function ensureSubscription(): void {
    if (unsubscribeStore) {
      return
    }
    previousStatuses = readStatuses()
    unsubscribeStore = store.subscribe(() => {
      const statuses = readStatuses()
      const previous = previousStatuses
      if (statuses === previous) {
        return
      }
      previousStatuses = statuses
      const pending: { listeners: Set<Listener>; listener: Listener }[] = []
      for (const listener of statusesListeners) {
        pending.push({ listeners: statusesListeners, listener })
      }
      // Each host's subscribers compare that host's entry, so one host's write never wakes another's readers.
      for (const [environmentId, listeners] of entryListeners) {
        if (statuses.get(environmentId) !== previous?.get(environmentId)) {
          for (const listener of listeners) {
            pending.push({ listeners, listener })
          }
        }
      }
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
    if (
      connections.size > 0 ||
      parkingListeners.size > 0 ||
      entryListeners.size > 0 ||
      statusesListeners.size > 0
    ) {
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

  /** Wakes when this host's status entry changes; another host's change never reaches it. */
  function subscribeEntry(environmentId: string | null, listener: Listener): () => void {
    if (environmentId === null) {
      return () => {}
    }
    ensureSubscription()
    let listeners = entryListeners.get(environmentId)
    if (!listeners) {
      listeners = new Set()
      entryListeners.set(environmentId, listeners)
    }
    const registered = () => listener()
    listeners.add(registered)
    const owned = listeners
    return () => {
      owned.delete(registered)
      if (owned.size === 0 && entryListeners.get(environmentId) === owned) {
        entryListeners.delete(environmentId)
      }
      releaseIfUnused()
    }
  }

  /** Wakes when any host's status changes, and on nothing else. */
  function subscribeStatuses(listener: Listener): () => void {
    ensureSubscription()
    const registered = () => listener()
    statusesListeners.add(registered)
    return () => {
      statusesListeners.delete(registered)
      releaseIfUnused()
    }
  }

  return {
    readStatuses,
    getConnectionSnapshot,
    subscribeConnection,
    getParkingSnapshot,
    subscribeParking,
    subscribeEntry,
    subscribeStatuses
  }
}

export type RuntimeStatusSubscriptions = ReturnType<typeof createRuntimeStatusSubscriptions>

const subscriptionsByStore = new WeakMap<object, RuntimeStatusSubscriptions>()

// Why getState: the bound hook and a slice's inner api are distinct objects sharing one getState.
function ownerKey(store: RuntimeStatusStore): object {
  return typeof store.getState === 'function' ? store.getState : store
}

/** The one host status owner per store, so every reader shares its baselines and listeners. */
export function runtimeStatusSubscriptionsFor(
  store: RuntimeStatusStore
): RuntimeStatusSubscriptions {
  const key = ownerKey(store)
  let subscriptions = subscriptionsByStore.get(key)
  if (!subscriptions) {
    subscriptions = createRuntimeStatusSubscriptions(store)
    subscriptionsByStore.set(key, subscriptions)
  }
  return subscriptions
}
