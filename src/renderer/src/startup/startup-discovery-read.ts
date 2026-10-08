import { withTimeout } from '../../../shared/promise-timeout-fallback'

// Local preload IPC has no deadline; match the remote-runtime read budget to abandon this launch check.
export const STARTUP_DISCOVERY_READ_TIMEOUT_MS = 15_000

export function readStartupDiscovery<T>(pending: Promise<T>): Promise<T | null> {
  return withTimeout<T | null>(
    pending.catch((error) => {
      console.error('Startup discovery read failed:', error)
      return null
    }),
    STARTUP_DISCOVERY_READ_TIMEOUT_MS,
    null
  )
}
