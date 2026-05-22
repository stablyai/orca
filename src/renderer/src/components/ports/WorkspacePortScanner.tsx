import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { getHasAnyWorktreesFromState } from '@/store/selectors'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  scanWorkspacePortsForTarget,
  workspacePortRuntimeTargetKey
} from '@/lib/workspace-port-actions'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'

const WORKSPACE_PORT_SCAN_INTERVAL_MS = 5_000

function makeUnavailableScan(reason: string): WorkspacePortScanResult {
  return {
    platform: 'unknown',
    scannedAt: Date.now(),
    ports: [],
    unavailableReason: reason
  }
}

export function WorkspacePortScanner(): null {
  const settings = useAppStore((s) => s.settings)
  const hasWorktrees = useAppStore(getHasAnyWorktreesFromState)
  const setWorkspacePortScan = useAppStore((s) => s.setWorkspacePortScan)
  const setWorkspacePortScanRefreshing = useAppStore((s) => s.setWorkspacePortScanRefreshing)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const generationRef = useRef(0)

  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const scanKey = `${workspacePortRuntimeTargetKey(runtimeTarget)}:all`

  const refresh = useCallback(() => {
    if (!hasWorktrees) {
      setWorkspacePortScan(null)
      setWorkspacePortScanRefreshing(false)
      return Promise.resolve()
    }
    if (inFlightRef.current) {
      return inFlightRef.current
    }

    const generation = generationRef.current
    setWorkspacePortScanRefreshing(true)
    const promise = scanWorkspacePortsForTarget(runtimeTarget)
      .then((result) => {
        if (generation === generationRef.current) {
          setWorkspacePortScan({ key: scanKey, result })
        }
      })
      .catch((error) => {
        if (generation !== generationRef.current) {
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        setWorkspacePortScan({
          key: scanKey,
          result: makeUnavailableScan(message || 'Workspace port scan failed.')
        })
      })
      .finally(() => {
        if (inFlightRef.current === promise) {
          inFlightRef.current = null
        }
        if (generation === generationRef.current) {
          setWorkspacePortScanRefreshing(false)
        }
      })
    inFlightRef.current = promise
    return promise
  }, [hasWorktrees, runtimeTarget, scanKey, setWorkspacePortScan, setWorkspacePortScanRefreshing])

  useEffect(() => {
    let cancelled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    generationRef.current += 1
    setWorkspacePortScan(null)

    const run = async (): Promise<void> => {
      try {
        if (document.visibilityState === 'visible') {
          await refresh()
        }
      } finally {
        if (!cancelled) {
          timeout = setTimeout(() => void run(), WORKSPACE_PORT_SCAN_INTERVAL_MS)
        }
      }
    }

    void run()

    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        void refresh()
      }
    }
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)

    return () => {
      cancelled = true
      generationRef.current += 1
      inFlightRef.current = null
      if (timeout) {
        clearTimeout(timeout)
      }
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [refresh, setWorkspacePortScan])

  return null
}
