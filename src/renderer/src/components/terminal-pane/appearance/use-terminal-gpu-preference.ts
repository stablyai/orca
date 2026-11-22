import { useEffect } from 'react'
import type { MountedTerminalPaneLifecycleDeps } from '../mounting/terminal-pane-lifecycle-types'

export function useTerminalGpuPreference(
  deps: Pick<MountedTerminalPaneLifecycleDeps, 'mountedManager' | 'managerRef' | 'settings'>
): void {
  useEffect(() => {
    if (!deps.mountedManager || deps.managerRef.current !== deps.mountedManager) {
      return
    }
    deps.managerRef.current.setTerminalGpuAcceleration(
      deps.settings?.terminalGpuAcceleration ?? 'auto'
    )
  }, [deps.mountedManager, deps.settings?.terminalGpuAcceleration, deps.managerRef])
}
