import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import { installRemoteHostPRAutoRefreshCadenceSync } from '@/store/github/refresh/remote-host-pr-auto-refresh-cadence-sync'

/** Keeps every paired host's PR auto-refresh cadence known to this window's review schedulers. */
export function useRemoteHostPRAutoRefreshCadence(): void {
  useEffect(() => installRemoteHostPRAutoRefreshCadenceSync(useAppStore), [])
}
