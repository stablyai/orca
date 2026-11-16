import { useSyncExternalStore } from 'react'
import type { CloudApiAvailability } from '../../../shared/cloud-api/cloud-api-types'
import { availabilityRetryDelay } from '@/lib/availability-retry'
import { useOrcaCloudEnabled } from '@/hooks/useOrcaCloudEnabled'

// One probe per renderer: whether this build has an Orca Cloud control plane (private/hosted builds).
// Settings navigation and the panes share it, so the sections never flicker in and out.
let availability: CloudApiAvailability | null = null
let probing = false
let failedAttempts = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function probe(): void {
  if (probing || availability || retryTimer) {
    return
  }
  const bridge = typeof window === 'undefined' ? undefined : window.api?.cloudApi
  if (!bridge) {
    availability = { status: 'unconfigured' }
    return
  }
  probing = true
  void bridge.availability().then(
    (next) => {
      availability = next
      probing = false
      failedAttempts = 0
      for (const listener of listeners) {
        listener()
      }
    },
    () => {
      // A failed probe is not "unconfigured": retry with capped backoff, and only while something
      // is subscribed (a new subscriber probes again on its own).
      probing = false
      const delay = availabilityRetryDelay(failedAttempts++)
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (listeners.size > 0) {
          probe()
        }
      }, delay)
    }
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  probe()
  return () => listeners.delete(listener)
}

const HIDDEN: CloudApiAvailability = { status: 'unconfigured' }

/** The build's control plane, reported as unconfigured while the rollout flag hides Orca Cloud. */
export function useOrcaCloudApiAvailability(): CloudApiAvailability | null {
  const enabled = useOrcaCloudEnabled()
  const value = useSyncExternalStore(
    subscribe,
    () => availability,
    () => null
  )
  return enabled ? value : HIDDEN
}

export function useOrcaCloudApiAvailable(): boolean {
  return useOrcaCloudApiAvailability()?.status === 'ready'
}
