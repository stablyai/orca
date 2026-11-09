import { useSyncExternalStore } from 'react'
import type { CloudApiAvailability } from '../../../shared/cloud-api/cloud-api-types'

// One probe per renderer: whether this build has an Orca Cloud control plane (private/hosted builds).
// Settings navigation and the panes share it, so the sections never flicker in and out.
let availability: CloudApiAvailability | null = null
let probing = false
const listeners = new Set<() => void>()

function probe(): void {
  if (probing || availability) {
    return
  }
  const bridge = typeof window === 'undefined' ? undefined : window.api?.cloudApi
  if (!bridge) {
    availability = { status: 'unconfigured' }
    return
  }
  probing = true
  void bridge
    .availability()
    .catch((): CloudApiAvailability => ({ status: 'unconfigured' }))
    .then((next) => {
      availability = next
      probing = false
      for (const listener of listeners) {
        listener()
      }
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  probe()
  return () => listeners.delete(listener)
}

export function useOrcaCloudApiAvailability(): CloudApiAvailability | null {
  return useSyncExternalStore(
    subscribe,
    () => availability,
    () => null
  )
}

export function useOrcaCloudApiAvailable(): boolean {
  return useOrcaCloudApiAvailability()?.status === 'ready'
}
