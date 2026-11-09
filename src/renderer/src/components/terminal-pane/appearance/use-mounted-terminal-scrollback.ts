import { useEffect } from 'react'
import { applyTerminalScrollbackRowsToMountedPanes } from './mounted-terminal-scrollback'
import type { UseTerminalPaneLifecycleDeps } from '../mounting/terminal-pane-lifecycle-types'

export function useMountedTerminalScrollback(
  deps: Pick<UseTerminalPaneLifecycleDeps, 'managerRef'>,
  terminalScrollbackRows: number
): void {
  useEffect(() => {
    const manager = deps.managerRef.current
    if (!manager) {
      return
    }
    applyTerminalScrollbackRowsToMountedPanes(manager, terminalScrollbackRows)
  }, [deps.managerRef, terminalScrollbackRows])
}
