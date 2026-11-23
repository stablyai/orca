import { useEffect } from 'react'
import { useAppStore } from '@/store/index'

const LOCAL_TARGET = { kind: 'local' } as const

/** Checks this computer's CLIs at launch, apart from the status bar so a hidden bar can't skip it; other hosts are checked when a chat starts there. */
export function useLocalAgentCliUpdateCheck(): void {
  const checkAgentCliUpdates = useAppStore((s) => s.checkAgentCliUpdates)
  useEffect(() => {
    void checkAgentCliUpdates(LOCAL_TARGET)
  }, [checkAgentCliUpdates])
}
