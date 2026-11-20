import { useCallback, useSyncExternalStore } from 'react'
import { runtimeStatusSubscriptionsFor } from './runtime-status-subscriptions'
import { isDisconnectedRuntimeHostState } from '@/runtime/hosts/connections/runtime-host-connection-state'
import type { RuntimeEnvironmentStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { useAppStore } from '../../../index'
import { useAppStateView, useAppStateViewActive } from '../../../retained-views/app-state-view'

const runtimeStatusSubscriptions = runtimeStatusSubscriptionsFor(useAppStore)

export function useRuntimeHostDisconnected(environmentId: string | null) {
  const subscribe = useCallback(
    (listener: () => void) =>
      runtimeStatusSubscriptions.subscribeConnection(environmentId, listener),
    [environmentId]
  )
  const getSnapshot = useCallback(
    () =>
      isDisconnectedRuntimeHostState(
        runtimeStatusSubscriptions.getConnectionSnapshot(environmentId)
      ),
    [environmentId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const readStatuses = () => useAppStore.getState().runtimeStatusByEnvironmentId

/** Every host's status; wakes on host status changes only. */
export function useRuntimeStatusByEnvironmentId(): ReturnType<typeof readStatuses> {
  return useSyncExternalStore(
    runtimeStatusSubscriptions.subscribeStatuses,
    readStatuses,
    readStatuses
  )
}

/** A value from one host's status; wakes only when that host's entry changes. */
export function useRuntimeHostStatusSelector<T>(
  environmentId: string | null | undefined,
  select: (entry: RuntimeEnvironmentStatus | undefined) => T
): T {
  const id = environmentId ?? null
  const subscribe = useCallback(
    (listener: () => void) => runtimeStatusSubscriptions.subscribeEntry(id, listener),
    [id]
  )
  const read = useCallback(
    () => select(id === null ? undefined : readStatuses().get(id)),
    [id, select]
  )
  return useSyncExternalStore(subscribe, read, read)
}

/** useRuntimeHostStatusSelector for a retained-view surface: a retained view's status never changes. */
export function useRuntimeHostStatusViewSelector<T>(
  environmentId: string | null | undefined,
  select: (entry: RuntimeEnvironmentStatus | undefined) => T
): T {
  const store = useAppStateView()
  const live = useAppStateViewActive()
  const id = environmentId ?? null
  const subscribe = useCallback(
    (listener: () => void) =>
      live ? runtimeStatusSubscriptions.subscribeEntry(id, listener) : () => {},
    [live, id]
  )
  const read = useCallback(
    () => select(id === null ? undefined : store.getState().runtimeStatusByEnvironmentId.get(id)),
    [store, id, select]
  )
  return useSyncExternalStore(subscribe, read, read)
}

export function usePairedRuntimeParkingEnvironmentIds() {
  return useSyncExternalStore(
    runtimeStatusSubscriptions.subscribeParking,
    runtimeStatusSubscriptions.getParkingSnapshot,
    runtimeStatusSubscriptions.getParkingSnapshot
  )
}

export function subscribeRuntimeHostConnectionState(
  environmentId: string,
  listener: (state: ReturnType<typeof runtimeStatusSubscriptions.getConnectionSnapshot>) => void
): () => void {
  const update = () => listener(runtimeStatusSubscriptions.getConnectionSnapshot(environmentId))
  const unsubscribe = runtimeStatusSubscriptions.subscribeConnection(environmentId, update)
  update()
  return unsubscribe
}
