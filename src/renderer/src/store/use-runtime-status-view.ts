import { useCallback, useSyncExternalStore } from 'react'
import { useAppStore } from './index'
import { createRuntimeStatusSubscriptions } from './runtime-status-subscriptions'
import { isDisconnectedRuntimeHostState } from '@/runtime/runtime-host-connection-state'

const runtimeStatusSubscriptions = createRuntimeStatusSubscriptions(useAppStore)

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
