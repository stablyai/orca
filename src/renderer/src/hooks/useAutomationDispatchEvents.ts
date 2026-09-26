import { useEffect } from 'react'
import { handleAutomationDispatchRequest } from './automation-dispatch-handler'

/**
 * Keeps the dispatch listener attached while withholding main's readiness
 * handshake until the renderer has hydrated its workspace catalog.
 */
export function useAutomationDispatchEvents(rendererReady: boolean): void {
  useEffect(() => {
    const unsubscribe = window.api.automations.onDispatchRequested(handleAutomationDispatchRequest)
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!rendererReady) {
      return
    }
    // Why: main evaluates overdue scheduled runs as soon as this signal arrives.
    // Wait until startup has hydrated the local repo catalog and workspace session,
    // or a valid project can be permanently recorded as skipped_unavailable (#12318).
    void window.api.automations.rendererReady()
  }, [rendererReady])
}
