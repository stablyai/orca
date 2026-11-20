import type { RuntimeEnvironmentStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import type { RuntimeHostConnectionState } from '../../../../../../shared/remote-runtime/host-status/runtime-host-connection-state'
import { createPairedRuntimeParkingEnvironmentIdsSelector } from '@/components/terminal-pane/parking/retention/paired-runtime-parking-capabilities'

type RuntimeStatusState = {
  runtimeStatusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
}
type RuntimeStatusStore = {
  getState: () => RuntimeStatusState
  subscribe: (
    listener: (state: RuntimeStatusState, previous: RuntimeStatusState) => void
  ) => () => void
}
type Listener = () => void
type RuntimeStatuses = RuntimeStatusState['runtimeStatusByEnvironmentId']
export type RuntimeStatusChange = {
  ids: ReadonlySet<string>
  added: readonly string[]
  deleted: ReadonlySet<string>
}
type ChangeListener = (change: RuntimeStatusChange) => void
type ConnectionSubscription = {
  snapshot: RuntimeHostConnectionState
  listeners: Set<Listener>
}

export function createRuntimeStatusSubscriptions(store: RuntimeStatusStore) {
  const connections = new Map<string, ConnectionSubscription>()
  const entryListeners = new Map<string, Set<Listener>>()
  const statusesListeners = new Set<Listener>()
  const parkingListeners = new Set<Listener>()
  const changeListeners = new Set<ChangeListener>()
  let selectParking = createPairedRuntimeParkingEnvironmentIdsSelector()
  let parkingSnapshot: ReadonlySet<string> | null = null
  let previousStatuses: RuntimeStatuses | undefined
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
    // A slice may subscribe while the store is still being created, before it has state.
    const initial: RuntimeStatusState | undefined = store.getState()
    previousStatuses = initial?.runtimeStatusByEnvironmentId
    unsubscribeStore = store.subscribe((_state, prior) => {
      const statuses = store.getState().runtimeStatusByEnvironmentId
      // Subscribed during creation: the first write's prior state is the real baseline.
      const previous = previousStatuses ?? prior?.runtimeStatusByEnvironmentId
      if (statuses === previous) {
        return
      }
      previousStatuses = statuses
      const pending: Listener[] = []
      const queue = <T>(listeners: Set<T>, listener: T, run: () => void): void => {
        pending.push(() => {
          if (!listeners.has(listener)) {
            return
          }
          // Baselines already moved, so one failing observer must not cancel the rest of this write.
          try {
            run()
          } catch (error) {
            console.error('Runtime status observer failed', error)
          }
        })
      }
      for (const listener of statusesListeners) {
        queue(statusesListeners, listener, listener)
      }
      if (changeListeners.size > 0) {
        const change = diffStatuses(previous, statuses)
        for (const listener of changeListeners) {
          queue(changeListeners, listener, () => listener(change))
        }
      }
      // Each host's subscribers compare that host's entry, so one host's write never wakes another's readers.
      for (const [environmentId, listeners] of entryListeners) {
        if (statuses.get(environmentId) !== previous?.get(environmentId)) {
          for (const listener of listeners) {
            queue(listeners, listener, listener)
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
          queue(subscription.listeners, listener, listener)
        }
      }
      if (parkingListeners.size > 0) {
        const snapshot = getParkingSnapshot()
        if (snapshot !== parkingSnapshot) {
          parkingSnapshot = snapshot
          for (const listener of parkingListeners) {
            queue(parkingListeners, listener, listener)
          }
        }
      }
      // Establish every comparison baseline before callbacks can commit nested writes.
      for (const run of pending) {
        run()
      }
    })
  }

  function releaseIfUnused(): void {
    if (
      connections.size > 0 ||
      parkingListeners.size > 0 ||
      entryListeners.size > 0 ||
      statusesListeners.size > 0 ||
      changeListeners.size > 0
    ) {
      return
    }
    unsubscribeStore?.()
    unsubscribeStore = null
    previousStatuses = undefined
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

  /** Names the hosts each status write touched, after every keyed view's baseline is set. */
  function subscribeStatusChanges(listener: ChangeListener): () => void {
    ensureSubscription()
    const registered: ChangeListener = (change) => listener(change)
    changeListeners.add(registered)
    return () => {
      changeListeners.delete(registered)
      releaseIfUnused()
    }
  }

  return {
    getConnectionSnapshot,
    subscribeConnection,
    getParkingSnapshot,
    subscribeParking,
    subscribeEntry,
    subscribeStatuses,
    subscribeStatusChanges
  }
}

function diffStatuses(
  previous: RuntimeStatuses | undefined,
  next: RuntimeStatuses
): RuntimeStatusChange {
  const ids = new Set<string>()
  const added: string[] = []
  const deleted = new Set<string>()
  for (const [environmentId, entry] of next) {
    if (!previous?.has(environmentId)) {
      added.push(environmentId)
      ids.add(environmentId)
    } else if (previous.get(environmentId) !== entry) {
      ids.add(environmentId)
    }
  }
  for (const environmentId of previous?.keys() ?? []) {
    if (!next.has(environmentId)) {
      deleted.add(environmentId)
      ids.add(environmentId)
    }
  }
  return { ids, added, deleted }
}

// Keyed by getState: the store's hook and the api its slices receive are different objects sharing it.
const subscriptionsByStore = new WeakMap<
  object,
  ReturnType<typeof createRuntimeStatusSubscriptions>
>()

/** Test doubles of the store may carry no getState; the double itself then keys its owner. */
function ownerKey(store: { getState?: unknown }): object {
  return typeof store.getState === 'function' ? store.getState : store
}

/** The one host-status subscription owner for this store, shared by every view of it. */
export function runtimeStatusSubscriptionsFor(
  store: RuntimeStatusStore
): ReturnType<typeof createRuntimeStatusSubscriptions> {
  const key = ownerKey(store)
  let subscriptions = subscriptionsByStore.get(key)
  if (!subscriptions) {
    subscriptions = createRuntimeStatusSubscriptions(store)
    subscriptionsByStore.set(key, subscriptions)
  }
  return subscriptions
}
