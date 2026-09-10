import { useEffect } from 'react'
import { installAppLifetimeIpcEvents } from './ipc-events/app-lifetime-ipc-bridge'
export {
  executeMaestroWorkspaceTabCommand,
  focusExactMobileSessionTab,
  openMaestroCanvasFromIpc
} from './ipc-events/maestro-workspace-ipc-bridge'

/** Installs the renderer IPC bridge once for the App lifetime. */
export function useIpcEvents(): void {
  useEffect(() => installAppLifetimeIpcEvents(), [])
}
