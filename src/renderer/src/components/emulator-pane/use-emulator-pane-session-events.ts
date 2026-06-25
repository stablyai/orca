import { useEffect } from 'react'
import type { EmulatorPaneSession, SimulatorDeviceRow } from './emulator-pane-types'

export const EMULATOR_LOCAL_SHUTDOWN_EVENT = 'orca:emulator-shutdown'

type UseEmulatorPaneSessionEventsArgs = {
  worktreeId: string
  applySession: (info: EmulatorPaneSession['info'], attached?: boolean) => void
  refreshDevices: (bootedTarget?: string | null) => Promise<SimulatorDeviceRow[]>
  clearSessionAfterShutdown: (deviceTarget?: string | null) => void
}

export function useEmulatorPaneSessionEvents({
  worktreeId,
  applySession,
  refreshDevices,
  clearSessionAfterShutdown
}: UseEmulatorPaneSessionEventsArgs): void {
  useEffect(() => {
    const onAuto = (ev: Event): void => {
      const detail = (ev as CustomEvent).detail as {
        worktreeId?: string
        info?: EmulatorPaneSession['info']
      }
      if (detail?.worktreeId && detail.worktreeId !== worktreeId) {
        return
      }
      if (!detail?.info?.streamUrl && !detail?.info?.wsUrl) {
        return
      }
      applySession(detail.info, true)
      void refreshDevices(detail.info.deviceUdid || detail.info.device)
    }
    window.addEventListener('orca:emulator-auto-attach', onAuto)
    return () => window.removeEventListener('orca:emulator-auto-attach', onAuto)
  }, [applySession, refreshDevices, worktreeId])

  useEffect(() => {
    const onShutdown = (ev: Event): void => {
      const detail = (ev as CustomEvent).detail as {
        worktreeId?: string
        deviceUdid?: string | null
      }
      if (detail?.worktreeId && detail.worktreeId !== worktreeId) {
        return
      }
      clearSessionAfterShutdown(detail?.deviceUdid)
    }
    window.addEventListener(EMULATOR_LOCAL_SHUTDOWN_EVENT, onShutdown)
    return () => window.removeEventListener(EMULATOR_LOCAL_SHUTDOWN_EVENT, onShutdown)
  }, [clearSessionAfterShutdown, worktreeId])
}
