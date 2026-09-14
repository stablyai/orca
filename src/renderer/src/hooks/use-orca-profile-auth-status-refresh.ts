import { useEffect } from 'react'
import { useAppStore } from '../store'

/**
 * Re-reads the cloud auth status whenever a surface that renders it mounts. The
 * store caches the startup value, so without this a session revoked since launch
 * still reads as connected. The cached value stays rendered while the fetch runs.
 */
export function useOrcaProfileAuthStatusRefresh(): void {
  const fetchAuthStatus = useAppStore((state) => state.fetchOrcaProfileAuthStatus)
  useEffect(() => {
    void fetchAuthStatus()
  }, [fetchAuthStatus])
}
