import { useCallback, useEffect, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { TailcatTunnelStatus } from '../../../../shared/tailcat-tunnel-status'

/** Polls the host's Tailcat status while `enabled`, and again whenever `refreshKey` changes. */
export function useTailcatTunnelStatus(
  enabled: boolean,
  refreshKey: unknown
): TailcatTunnelStatus | null {
  const [status, setStatus] = useState<TailcatTunnelStatus | null>(null)
  const mountedRef = useMountedRef()
  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.mobile.getTunnelStatus()
      if (mountedRef.current) {
        setStatus(next)
      }
    } catch {
      if (mountedRef.current) {
        setStatus(null)
      }
    }
  }, [mountedRef])
  useEffect(() => {
    if (enabled) {
      void load()
    }
  }, [enabled, load, refreshKey])
  return status
}
