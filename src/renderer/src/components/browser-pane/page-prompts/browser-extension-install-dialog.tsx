import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store'
import type { BrowserExtensionInstallPromptRequest } from '../../../../../shared/browser/extensions/browser-extension-webstore'

const BrowserExtensionInstallDialogSurface = lazy(() =>
  import('./browser-extension-install-dialog-surface').then((module) => ({
    default: module.BrowserExtensionInstallDialogSurface
  }))
)

/** Orca's confirmation for store installs and store-page removals; main waits on the answer. */
export function BrowserExtensionInstallDialog(): React.JSX.Element | null {
  const [requests, setRequests] = useState<BrowserExtensionInstallPromptRequest[]>([])
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null)
  const [hasOpened, setHasOpened] = useState(false)
  const requestsRef = useRef(requests)
  const setContextualToursBlockingSurfaceVisible = useAppStore(
    (state) => state.setContextualToursBlockingSurfaceVisible
  )
  const activeRequest = requests[0] ?? null

  useEffect(() => {
    requestsRef.current = requests
  }, [requests])

  const removeRequest = useCallback((requestId: string) => {
    setRequests((current) => current.filter((request) => request.requestId !== requestId))
    setRespondingRequestId((current) => (current === requestId ? null : current))
  }, [])

  useEffect(() => {
    const stopRequests = window.api.browser.onExtensionInstallPrompt((request) => {
      setHasOpened(true)
      setRequests((current) => [...current, request])
    })
    const stopClosures = window.api.browser.onExtensionInstallPromptClosed(({ requestId }) => {
      removeRequest(requestId)
    })
    return () => {
      stopRequests()
      stopClosures()
      for (const request of requestsRef.current) {
        void window.api.browser
          .respondExtensionInstallPrompt({ requestId: request.requestId, accepted: false })
          .catch(() => {})
      }
    }
  }, [removeRequest])

  useEffect(() => {
    setContextualToursBlockingSurfaceVisible(activeRequest !== null)
    return () => setContextualToursBlockingSurfaceVisible(false)
  }, [activeRequest, setContextualToursBlockingSurfaceVisible])

  const respond = useCallback(
    (accepted: boolean) => {
      const request = requestsRef.current[0]
      if (!request || respondingRequestId === request.requestId) {
        return
      }
      setRespondingRequestId(request.requestId)
      void window.api.browser
        .respondExtensionInstallPrompt({ requestId: request.requestId, accepted })
        .then((handled) => {
          if (handled) {
            removeRequest(request.requestId)
          } else {
            setRespondingRequestId(null)
          }
        })
        .catch(() => setRespondingRequestId(null))
    },
    [removeRequest, respondingRequestId]
  )

  if (!activeRequest && !hasOpened) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <BrowserExtensionInstallDialogSurface
        activeRequest={activeRequest}
        respondingRequestId={respondingRequestId}
        respond={respond}
      />
    </Suspense>
  )
}
