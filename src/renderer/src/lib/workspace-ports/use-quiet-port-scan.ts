import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { refreshWorkspacePortScanForTarget } from './workspace-port-scan-refresh'

/** Scans one host without the shared spinner; `pending` follows only the latest request. */
export function useQuietPortScan(): {
  pending: boolean
  scan: (runtimeTarget: RuntimeClientTarget) => void
} {
  const [pending, setPending] = useState(false)
  const latestRequestRef = useRef(0)
  const scan = useCallback((runtimeTarget: RuntimeClientTarget) => {
    const request = ++latestRequestRef.current
    setPending(true)
    void refreshWorkspacePortScanForTarget({
      runtimeTarget,
      replaceWorkspacePortScans: useAppStore.getState().replaceWorkspacePortScans,
      getWorkspacePortScansByKey: () => useAppStore.getState().workspacePortScansByKey
    }).finally(() => {
      if (latestRequestRef.current === request) {
        setPending(false)
      }
    })
  }, [])
  return { pending, scan }
}
