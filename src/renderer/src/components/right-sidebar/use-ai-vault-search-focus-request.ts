import { useEffect, useEffectEvent, useState } from 'react'
import { useAppStore } from '@/store'

/**
 * Consumes Settings' "open the panel, ready to type" request.
 *
 * Returns an id the header focuses its box on, and runs `onRequest` once so the
 * panel can widen its own scope. The request is cleared as it is taken, so a
 * later remount of the panel stays where the user left it.
 */
export function useAiVaultSearchFocusRequest(onRequest: () => void): number {
  const [focusRequestId, setFocusRequestId] = useState(0)
  const requested = useAppStore((state) => state.aiVaultSearchFocusRequested)
  const clearRequest = useAppStore((state) => state.clearAiVaultSearchFocusRequest)
  const runRequest = useEffectEvent(onRequest)

  useEffect(() => {
    if (!requested) {
      return
    }
    runRequest()
    setFocusRequestId((value) => value + 1)
    clearRequest()
  }, [clearRequest, requested])

  return focusRequestId
}
