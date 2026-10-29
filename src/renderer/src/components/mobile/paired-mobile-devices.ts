import { useCallback, useEffect, useSyncExternalStore } from 'react'

export type PairedMobileDevice = {
  deviceId: string
  name: string
  pairedAt: number
  lastSeenAt: number
}

type PairedMobileDevicesSnapshot = {
  devices: readonly PairedMobileDevice[]
  loaded: boolean
  loading: boolean
  // Distinguish failed loading from a confirmed empty device list.
  error: boolean
}

type RefreshPairedMobileDevicesOptions = {
  force?: boolean
}

const EMPTY_SNAPSHOT: PairedMobileDevicesSnapshot = {
  devices: [],
  loaded: false,
  loading: false,
  error: false
}

let snapshot = EMPTY_SNAPSHOT
// Share device-list IPC across Sidebar, Mobile and Settings so simultaneous mounts do not fan out.
let activeRequest: {
  id: number
  promise: Promise<readonly PairedMobileDevice[]>
} | null = null
let latestRequestId = 0

const listeners = new Set<() => void>()

function publish(nextSnapshot: PairedMobileDevicesSnapshot): void {
  snapshot = nextSnapshot
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): PairedMobileDevicesSnapshot {
  return snapshot
}

// Return the current request or published devices when superseded, never data the cache already rejected.
function supersededResult():
  | Promise<readonly PairedMobileDevice[]>
  | readonly PairedMobileDevice[] {
  return activeRequest?.promise ?? snapshot.devices
}

export function getPairedMobileDevicesSnapshot(): readonly PairedMobileDevice[] {
  return snapshot.devices
}

export function replacePairedMobileDevices(devices: readonly PairedMobileDevice[]): void {
  latestRequestId += 1
  activeRequest = null
  publish({
    devices: [...devices],
    loaded: true,
    loading: false,
    error: false
  })
}

export function refreshPairedMobileDevices({
  force = false
}: RefreshPairedMobileDevicesOptions = {}): Promise<readonly PairedMobileDevice[]> {
  if (activeRequest && !force) {
    return activeRequest.promise
  }

  const requestId = latestRequestId + 1
  latestRequestId = requestId
  publish({ ...snapshot, loading: true })

  const promise = window.api.mobile
    .listDevices()
    .then((result) => {
      const devices = [...result.devices]
      if (requestId !== latestRequestId) {
        return supersededResult()
      }
      publish({
        devices,
        loaded: true,
        loading: false,
        error: false
      })
      return devices
    })
    .catch((error: unknown) => {
      if (requestId !== latestRequestId) {
        return supersededResult()
      }
      // Keep loaded true to prevent automatic retry loops; error allows explicit or reconnect recovery.
      publish({
        ...snapshot,
        loaded: true,
        loading: false,
        error: true
      })
      throw error
    })
    .finally(() => {
      if (activeRequest?.id === requestId) {
        activeRequest = null
      }
    })

  activeRequest = { id: requestId, promise }
  return promise
}

// Share one focus/online recovery listener so failed loads retry without polling or per-consumer IPC fan-out.
let enabledConsumerCount = 0

function recoverPairedMobileDevicesOnReconnect(): void {
  if (enabledConsumerCount > 0 && snapshot.error) {
    void refreshPairedMobileDevices({ force: true }).catch(() => {})
  }
}

function addRecoveryConsumer(): () => void {
  if (enabledConsumerCount === 0) {
    window.addEventListener('focus', recoverPairedMobileDevicesOnReconnect)
    window.addEventListener('online', recoverPairedMobileDevicesOnReconnect)
  }
  enabledConsumerCount += 1
  return () => {
    enabledConsumerCount -= 1
    if (enabledConsumerCount === 0) {
      window.removeEventListener('focus', recoverPairedMobileDevicesOnReconnect)
      window.removeEventListener('online', recoverPairedMobileDevicesOnReconnect)
    }
  }
}

export function usePairedMobileDevices({
  enabled = true,
  refreshOnMount = true
}: {
  enabled?: boolean
  refreshOnMount?: boolean
} = {}): {
  devices: readonly PairedMobileDevice[]
  loaded: boolean
  loading: boolean
  error: boolean
  hasPairedDevice: boolean
  refresh: typeof refreshPairedMobileDevices
} {
  const currentSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const refresh = useCallback(
    (options?: RefreshPairedMobileDevicesOptions) => refreshPairedMobileDevices(options),
    []
  )

  useEffect(() => {
    if (!enabled || !refreshOnMount || currentSnapshot.loaded || currentSnapshot.loading) {
      return
    }
    void refreshPairedMobileDevices().catch(() => {
      // Callers that need visible error handling perform explicit refreshes.
    })
  }, [currentSnapshot.loaded, currentSnapshot.loading, enabled, refreshOnMount])

  // Register recovery while mounted because loaded-gated effects cannot retry failed loads without looping.
  useEffect(() => {
    if (!enabled) {
      return
    }
    return addRecoveryConsumer()
  }, [enabled])

  return {
    ...currentSnapshot,
    hasPairedDevice: currentSnapshot.devices.length > 0,
    refresh
  }
}

export function _resetPairedMobileDevicesCacheForTests(): void {
  latestRequestId += 1
  activeRequest = null
  if (enabledConsumerCount > 0) {
    window.removeEventListener('focus', recoverPairedMobileDevicesOnReconnect)
    window.removeEventListener('online', recoverPairedMobileDevicesOnReconnect)
  }
  enabledConsumerCount = 0
  publish(EMPTY_SNAPSHOT)
}
