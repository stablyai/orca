import { useEffect, useEffectEvent } from 'react'
import { useAppStore } from '@/store'

/** Consume and clear Settings’ focus request once so remounts preserve the user’s position. */
export function useAiVaultSearchFocusRequest(onRequest: () => void): void {
  const requested = useAppStore((state) => state.aiVaultSearchFocusRequested)
  const clearRequest = useAppStore((state) => state.clearAiVaultSearchFocusRequest)
  const runRequest = useEffectEvent(onRequest)

  useEffect(() => {
    if (!requested) {
      return
    }
    runRequest()
    clearRequest()
  }, [clearRequest, requested])
}
