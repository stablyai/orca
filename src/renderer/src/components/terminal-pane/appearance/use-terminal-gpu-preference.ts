import { useEffect } from 'react'
import type { UseTerminalPaneLifecycleDeps } from '../mounting/terminal-pane-lifecycle-types'

export function useTerminalGpuPreference(
  deps: Pick<UseTerminalPaneLifecycleDeps, 'managerRef' | 'settings'>
): void {
  useEffect(() => {
    deps.managerRef.current?.setTerminalGpuAcceleration(
      deps.settings?.terminalGpuAcceleration ?? 'auto'
    )
  }, [deps.settings?.terminalGpuAcceleration, deps.managerRef])
}
