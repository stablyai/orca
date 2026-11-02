import { useEffect } from 'react'
import { useAppStore } from '../store'

/** Refresh cached auth on surface mount so post-launch revocation appears; retain the cached display while fetching. */
export function useOrcaProfileAuthStatusRefresh(): void {
  const fetchAuthStatus = useAppStore((state) => state.fetchOrcaProfileAuthStatus)
  useEffect(() => {
    void fetchAuthStatus()
  }, [fetchAuthStatus])
}
