import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { handleAutomationDispatchRequest } from './automation-dispatch-handler'

export function useAutomationDispatchEvents(): void {
  useEffect(() => {
    let disposed = false
    let announcedReady = false
    const unsubscribeDispatch = window.api.automations.onDispatchRequested(
      handleAutomationDispatchRequest
    )
    const announceReady = (): void => {
      const state = useAppStore.getState()
      if (
        disposed ||
        announcedReady ||
        !state.hydrationSucceeded ||
        !state.terminalStartupRestorationReady
      ) {
        return
      }
      // Readiness can synchronously dispatch due runs against the hydrated store.
      announcedReady = true
      void window.api.automations.rendererReady().catch((error) => {
        console.error('[automations] Failed to announce renderer readiness:', error)
      })
    }
    const unsubscribeStore = useAppStore.subscribe(announceReady)
    announceReady()
    return () => {
      disposed = true
      unsubscribeStore()
      unsubscribeDispatch()
    }
  }, [])
}
