import { useEffect, useEffectEvent } from 'react'
import { useAppStore } from '@/store'

/**
 * Consumes Settings' "open the panel, ready to type" request.
 *
 * Runs `onRequest` once per request and clears it as it is taken, so a later
 * remount of the panel stays where the user left it.
 */
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
