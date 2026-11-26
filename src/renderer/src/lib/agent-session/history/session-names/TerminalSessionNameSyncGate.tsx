import { useEffect } from 'react'
import { startTerminalSessionNameSync } from './terminal-session-name-sync'
import { scheduleAfterInputQuiet } from '@/lib/window-activity/input-quiet-scheduler'
import { useAppStore } from '@/store/index'

const SYNC_DELAY_MS = 1_000
const SYNC_QUIET_MS = 1_500
const SYNC_IDLE_TIMEOUT_MS = 3_000

export function TerminalSessionNameSyncGate(): null {
  useEffect(
    () =>
      startTerminalSessionNameSync({
        getState: useAppStore.getState,
        subscribe: useAppStore.subscribe,
        scheduleReconcile: (callback) =>
          scheduleAfterInputQuiet(callback, {
            delayMs: SYNC_DELAY_MS,
            quietMs: SYNC_QUIET_MS,
            idleTimeoutMs: SYNC_IDLE_TIMEOUT_MS
          })
      }),
    []
  )
  return null
}
