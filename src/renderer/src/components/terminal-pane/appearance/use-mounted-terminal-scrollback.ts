import { useEffect } from 'react'
import { applyTerminalScrollbackRowsToMountedPanes } from './mounted-terminal-scrollback'
import type { MountedTerminalPaneLifecycleDeps } from '../mounting/terminal-pane-lifecycle-types'

export function useMountedTerminalScrollback(
  deps: Pick<MountedTerminalPaneLifecycleDeps, 'mountedManager' | 'managerRef'>,
  terminalScrollbackRows: number
): void {
  useEffect(() => {
    const manager = deps.managerRef.current
    if (!deps.mountedManager || manager !== deps.mountedManager) {
      return
    }
    applyTerminalScrollbackRowsToMountedPanes(manager, terminalScrollbackRows)
  }, [deps.mountedManager, deps.managerRef, terminalScrollbackRows])
}
