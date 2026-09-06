import { useEffect } from 'react'
import { handleAutomationDispatchRequest } from './automation-dispatch-handler'

export function useAutomationDispatchEvents(): void {
  useEffect(() => {
    const unsubscribe = window.api.automations.onDispatchRequested(handleAutomationDispatchRequest)
    void window.api.automations.rendererReady()
    return unsubscribe
  }, [])
}
