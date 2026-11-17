import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { OrcaProfileAuthStatus } from '../../../shared/orca-profiles/orca-profiles'

// Whether this install shows Orca Cloud entry points (Run on: Orca Cloud, Settings › Orca Cloud,
// the account menu's Team and Plan & billing). Off by default. The account's `cloud.available`
// capability (a server allowlist, cached with the session) turns it on; dev, e2e and internal
// builds force it on (orcaCloudForced, set by main). UI only: cloud services never consult it.

export const ORCA_CLOUD_AVAILABLE_CAPABILITY = 'cloud.available'

export function orcaCloudEnabledFor(auth: OrcaProfileAuthStatus | null): boolean {
  if (auth?.orcaCloudForced !== undefined) {
    return auth.orcaCloudForced
  }
  return (
    auth?.state === 'connected' &&
    auth.capabilities?.flags[ORCA_CLOUD_AVAILABLE_CAPABILITY] === true
  )
}

// Fixtures and tests pin the answer; null follows the account.
let pinned: boolean | null = null
const pinListeners = new Set<() => void>()

export function setOrcaCloudEnabledForTests(value: boolean | null): void {
  pinned = value
  pinListeners.forEach((listener) => listener())
}

export function useOrcaCloudEnabled(): boolean {
  const fromAccount = useAppStore((s) => orcaCloudEnabledFor(s.orcaProfileAuthStatus))
  const pin = useSyncExternalStore(
    (listener) => {
      pinListeners.add(listener)
      return () => pinListeners.delete(listener)
    },
    () => pinned
  )
  return pin ?? fromAccount
}
