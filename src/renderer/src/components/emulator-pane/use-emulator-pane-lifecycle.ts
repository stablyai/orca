import { useEffect } from 'react'
import {
  cancelPendingSimulatorPaneShutdown,
  scheduleSimulatorPaneManagedShutdown
} from '@/lib/simulator-pane-shutdown-scheduler'
import type { SimulatorDeviceRow } from './emulator-pane-types'

type UseEmulatorPaneLifecycleArgs = {
  mountedRef: { current: boolean }
  refreshDevices: () => Promise<SimulatorDeviceRow[]>
  tabId?: string
  worktreeId: string
}

export function useEmulatorPaneLifecycle({
  mountedRef,
  refreshDevices,
  tabId,
  worktreeId
}: UseEmulatorPaneLifecycleArgs): void {
  useEffect(() => {
    mountedRef.current = true
    cancelPendingSimulatorPaneShutdown(worktreeId)
    void refreshDevices()
    return () => {
      mountedRef.current = false
      scheduleSimulatorPaneManagedShutdown(worktreeId, tabId)
    }
  }, [mountedRef, refreshDevices, tabId, worktreeId])
}
