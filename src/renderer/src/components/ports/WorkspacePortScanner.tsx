import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { getHasAnyWorktreesFromState } from '@/store/selectors'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  scanWorkspacePortsForTarget,
  workspacePortRuntimeTargetKey
} from '@/lib/workspace-port-actions'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'

const WORKSPACE_PORT_SCAN_INTERVAL_MS = 30_000

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
      })
    inFlightRef.current = promise
    return promise
  }, [hasWorktrees, runtimeTarget, scanKey, setWorkspacePortScan, setWorkspacePortScanRefreshing])

  useEffect(() => {
    generationRef.current += 1
    setWorkspacePortScan(null)

    // Why: workspace port scans can cross runtime IPC or shell out remotely.
    // Keep the timer stopped while no UI can display the result; visibility
    // changes run one immediate refresh on return.
    const stopVisibleInterval = installWindowVisibilityInterval({
      run: () => void refresh(),
      intervalMs: WORKSPACE_PORT_SCAN_INTERVAL_MS
    })

    return () => {
      generationRef.current += 1
      inFlightRef.current = null
      stopVisibleInterval()
    }
  }, [refresh, setWorkspacePortScan])

  return null
}
