import { useEffect, useEffectEvent } from 'react'
import { useAppStore } from '@/store'

/** Consume and clear Settings’ focus request once so remounts preserve the user’s position. */
export function useAiVaultSearchFocusRequest(onRequest: (keepScope: boolean) => void): void {
  const requested = useAppStore((state) => state.aiVaultSearchFocusRequested)
  const keepScope = useAppStore((state) => state.aiVaultSearchKeepScope)
  const clearRequest = useAppStore((state) => state.clearAiVaultSearchFocusRequest)
  const runRequest = useEffectEvent(onRequest)

  useEffect(() => {
    if (!requested) {
      return
    }
    runRequest(keepScope)
    clearRequest()
  }, [clearRequest, keepScope, requested])
}
