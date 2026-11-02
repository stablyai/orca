import { useEffect } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { handleAutomationDispatchRequest } from './automation-dispatch-handler'

const rendererDocumentId = createBrowserUuid()

export function useAutomationDispatchEvents(): void {
  useEffect(() => {
    const unsubscribe = window.api.automations.onDispatchRequested(handleAutomationDispatchRequest)
    void window.api.automations.rendererReady({ documentId: rendererDocumentId })
    return unsubscribe
  }, [])
}
