import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import { runtimeStatusSubscriptionsFor } from '@/store/slices/runtime-status/views/runtime-status-subscriptions'

const LOCAL_TARGET = { kind: 'local' } as const
// Defer background CLI update probes past initial launch so they do not spike startup memory/CPU.
const STARTUP_CHECK_DELAY_MS = 15_000

/** Checks this computer's CLIs shortly after launch, then lists what each paired host already found as it connects; apart from the status bar so a hidden bar can't skip it. */
export function useAgentCliUpdateHostChecks(): void {
  useEffect(() => {
    let unsubscribe = (): void => {}
    const timer = window.setTimeout(() => {
      const checkHosts = (): void => useAppStore.getState().checkConnectedAgentCliUpdateHosts()
      void useAppStore.getState().checkAgentCliUpdates(LOCAL_TARGET)
      checkHosts()
      unsubscribe = runtimeStatusSubscriptionsFor(useAppStore).subscribeStatuses(checkHosts)
    }, STARTUP_CHECK_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [])
}
