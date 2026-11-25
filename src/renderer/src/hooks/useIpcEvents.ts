import { useEffect } from 'react'
import { installAppLifetimeIpcEvents } from './ipc-events/app-lifetime-ipc-bridge'

export function useIpcEvents(): void {
  useEffect(() => installAppLifetimeIpcEvents(), [])
}
