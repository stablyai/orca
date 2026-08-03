import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceServiceScanResult } from '../../../../shared/workspace-services'
import { useMountedRef } from '@/hooks/useMountedRef'

export type WorkspaceServicesState = {
  scan: WorkspaceServiceScanResult | null
  isRefreshing: boolean
  error: string | null
  refresh: () => Promise<void>
}

/** Fast enough that a service started in a terminal appears while the user still expects it. */
const POLL_INTERVAL_MS = 8_000

/**
 * Scan on mount, on workspace change, and on a poll while the window is visible.
 *
 * One scan spawns lsof, docker and ps, so the poll pauses whenever the window
 * is hidden and never stacks: a tick landing while a scan is still running is
 * skipped rather than queued. A panel that only updated when asked read as
 * broken, which is worse than the cost of the timer.
 */
export function useWorkspaceServices(
  repoId: string | null | undefined,
  enabled: boolean
): WorkspaceServicesState {
  const [scan, setScan] = useState<WorkspaceServiceScanResult | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useMountedRef()
  // Why: a slow scan started for the previous workspace must not overwrite the
  // result of the one the user is now looking at.
  const requestSequenceRef = useRef(0)
  const inFlightRef = useRef(false)

  const runScan = useCallback(
    async (silent: boolean) => {
      if (!enabled) {
        return
      }
      inFlightRef.current = true
      const sequence = ++requestSequenceRef.current
      // Why: a poll must not spin the refresh icon every few seconds. Only an
      // explicit refresh shows progress; background scans update in place.
      if (!silent) {
        setIsRefreshing(true)
      }
      try {
        const result = await window.api.workspacePorts.scanServices(repoId ? { repoId } : {})
        if (!mountedRef.current || sequence !== requestSequenceRef.current) {
          return
        }
        setScan(result)
        setError(null)
      } catch (cause) {
        if (!mountedRef.current || sequence !== requestSequenceRef.current) {
          return
        }
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        inFlightRef.current = false
        if (!silent && mountedRef.current && sequence === requestSequenceRef.current) {
          setIsRefreshing(false)
        }
      }
    },
    [enabled, mountedRef, repoId]
  )

  const refresh = useCallback(() => runScan(false), [runScan])

  useEffect(() => {
    if (!enabled) {
      return
    }
    void runScan(false)

    const tick = (): void => {
      if (document.hidden || inFlightRef.current) {
        return
      }
      void runScan(true)
    }
    const timer = window.setInterval(tick, POLL_INTERVAL_MS)
    // Why: returning to a window that was hidden for a while should show the
    // current truth immediately rather than after the next tick.
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [enabled, runScan])

  return { scan, isRefreshing, error, refresh }
}
