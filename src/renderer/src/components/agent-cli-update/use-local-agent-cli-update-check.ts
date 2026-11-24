import { useEffect } from 'react'
import { useAppStore } from '@/store/index'

const LOCAL_TARGET = { kind: 'local' } as const
// Defer background CLI update probes past initial launch so they do not spike startup memory/CPU.
const STARTUP_CHECK_DELAY_MS = 15_000

/** Checks this computer's CLIs shortly after launch, apart from the status bar so a hidden bar can't skip it; other hosts are checked when a chat starts there. */
export function useLocalAgentCliUpdateCheck(): void {
  const checkAgentCliUpdates = useAppStore((s) => s.checkAgentCliUpdates)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void checkAgentCliUpdates(LOCAL_TARGET)
    }, STARTUP_CHECK_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [checkAgentCliUpdates])
}
