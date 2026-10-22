import { useCallback, useEffect, useRef, useState } from 'react'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import {
  isMacUserAgent,
  resolveSystemSleepHoldState,
  type SystemSleepHoldState
} from '@/components/status-bar/system-sleep-hold-copy'
import type { SystemSleepHold } from '../../../shared/computer-awake-mode'
import { startSystemSleepHoldPoller, type SystemSleepHoldPoller } from './system-sleep-hold-poller'

export function useSystemSleepHold(): { state: SystemSleepHoldState; refresh: () => void } {
  const [hold, setHold] = useState<SystemSleepHold | null>(null)
  const pollerRef = useRef<SystemSleepHoldPoller | null>(null)

  useEffect(() => {
    const api = window.api?.agentAwake
    if (isPairedWebClientWindow() || typeof api?.getSystemSleepHold !== 'function') {
      return
    }
    const poller = startSystemSleepHoldPoller({
      read: () => api.getSystemSleepHold?.() ?? Promise.reject(new Error('no-method')),
      onHold: setHold
    })
    pollerRef.current = poller
    return () => {
      pollerRef.current = null
      poller.dispose()
    }
  }, [])

  const refresh = useCallback(() => pollerRef.current?.refresh(), [])
  return { state: resolveSystemSleepHoldState(hold, isMacUserAgent()), refresh }
}
