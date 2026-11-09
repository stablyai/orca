import { useCallback, useSyncExternalStore } from 'react'
import { runtimeStatusSubscriptions } from './runtime-status-subscription-store'
import { isDisconnectedRuntimeHostState } from '@/runtime/hosts/connections/runtime-host-connection-state'

export function useRuntimeHostRetired(environmentId: string | null): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      runtimeStatusSubscriptions.subscribeHostLifetime(environmentId, listener),
    [environmentId]
  )
  const getSnapshot = useCallback(
    () => runtimeStatusSubscriptions.getHostSnapshot(environmentId)?.retired === true,
    [environmentId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

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

export function usePairedRuntimeParkingEnvironmentIds() {
  return useSyncExternalStore(
    runtimeStatusSubscriptions.subscribeParking,
    runtimeStatusSubscriptions.getParkingSnapshot,
    runtimeStatusSubscriptions.getParkingSnapshot
  )
}
