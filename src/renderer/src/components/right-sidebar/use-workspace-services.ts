import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceServiceScanResult } from '../../../../shared/workspace-services'
import { useMountedRef } from '@/hooks/useMountedRef'

export type WorkspaceServicesState = {
  scan: WorkspaceServiceScanResult | null
  isRefreshing: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Scan on mount and whenever the workspace changes, then only on demand.
 *
 * Why no poll: one scan spawns lsof, docker and ps. The panel sits below the
 * file tree and is visible for the whole session, so a timer would run those
 * three commands forever for a list that changes a few times an hour. The
 * refresh button is the deliberate trigger.
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

  const refresh = useCallback(async () => {
    if (!enabled) {
      return
    }
    const sequence = ++requestSequenceRef.current
    setIsRefreshing(true)
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
      if (mountedRef.current && sequence === requestSequenceRef.current) {
        setIsRefreshing(false)
      }
    }
  }, [enabled, mountedRef, repoId])

  useEffect(() => {
    if (!enabled) {
      return
    }
    void refresh()
  }, [enabled, refresh])

  return { scan, isRefreshing, error, refresh }
}
