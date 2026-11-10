import { useEffect, useSyncExternalStore } from 'react'

// Known before a menu opens, so the Orca Cloud-only item never pops in under the pointer.
let ids: ReadonlySet<string> = new Set()
let inFlight: Promise<void> | null = null
let primed = false
const listeners = new Set<() => void>()

export function refreshCloudEnvironmentIds(): Promise<void> {
  const list = window.api?.ephemeralVm?.cloudEnvironmentIds
  if (typeof list !== 'function') {
    return Promise.resolve()
  }
  inFlight ??= list()
    .then((next) => {
      // The web client's fallback API resolves undefined.
      if (Array.isArray(next)) {
        ids = new Set(next)
        for (const listener of listeners) {
          listener()
        }
      }
    })
    .catch(() => {})
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Non-React read of the last loaded list; call refreshCloudEnvironmentIds first when it matters. */
export function isKnownCloudEnvironment(environmentId: string): boolean {
  return ids.has(environmentId)
}

export function useIsCloudEnvironment(environmentId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => (environmentId ? ids.has(environmentId) : false))
}

/** Loads the list once per app session; each opened menu refreshes it for new workspaces. */
export function usePrimeCloudEnvironmentIds(): void {
  useEffect(() => {
    if (!primed) {
      primed = true
      void refreshCloudEnvironmentIds()
    }
  }, [])
}

/** The loaded list itself, for memos that read isKnownCloudEnvironment imperatively. */
export function useCloudEnvironmentIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => ids)
}
