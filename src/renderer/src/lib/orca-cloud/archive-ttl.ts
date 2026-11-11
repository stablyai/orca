// How many days an archived workspace's snapshot is kept, from the control plane's GET /v1/config
// (ARCHIVE_TTL_DAYS or its 30-day default), so the "until <date>" copy matches what reconcile deletes.
import { useSyncExternalStore } from 'react'
import { cloudWorkspaceApi } from './orca-cloud-workspace-store'

let ttlDays: number | null = null
let request: Promise<void> | null = null
const listeners = new Set<() => void>()

function load(): void {
  const api = cloudWorkspaceApi()
  if (request || !api) {
    return
  }
  request = api
    .getConfig()
    .then((config) => {
      if (config?.archiveTtlDays) {
        ttlDays = config.archiveTtlDays
        listeners.forEach((listener) => listener())
      } else {
        // Offline or an older control plane: ask again the next time a definition renders.
        request = null
      }
    })
    .catch(() => {
      request = null
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  load()
  return () => listeners.delete(listener)
}

/** Null until the control plane answers; callers then fall back to copy without a date. */
export function useArchiveTtlDays(): number | null {
  return useSyncExternalStore(subscribe, () => ttlDays)
}

/** Tests and fixtures: seed or clear the cached TTL. */
export function setArchiveTtlDaysForTest(days: number | null): void {
  ttlDays = days
  request = days === null ? null : Promise.resolve()
  listeners.forEach((listener) => listener())
}
