import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store'
import type { BrowserWebAuthnAccountRequest } from '../../../../../shared/browser/prompts/browser-webauthn-account'

const BrowserWebAuthnAccountDialogSurface = lazy(() =>
  import('./browser-webauthn-account-dialog-surface').then((module) => ({
    default: module.BrowserWebAuthnAccountDialogSurface
  }))
)

export function BrowserWebAuthnAccountDialog(): React.JSX.Element | null {
  const [requests, setRequests] = useState<BrowserWebAuthnAccountRequest[]>([])
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
    const stopRequests = window.api.browser.onWebAuthnAccountRequest((request) => {
      setHasOpened(true)
      setRequests((current) => [...current, request])
    })
    const stopClosures = window.api.browser.onWebAuthnAccountRequestClosed(({ requestId }) => {
      removeRequest(requestId)
    })
    return () => {
      stopRequests()
      stopClosures()
      for (const request of requestsRef.current) {
        void window.api.browser
          .respondWebAuthnAccount({
            requestId: request.requestId,
            credentialId: null
          })
          .catch(() => {})
      }
    }
  }, [removeRequest])

  useEffect(() => {
    setContextualToursBlockingSurfaceVisible(activeRequest !== null)
    return () => setContextualToursBlockingSurfaceVisible(false)
  }, [activeRequest, setContextualToursBlockingSurfaceVisible])

  const respond = useCallback(
    (credentialId: string | null) => {
      const request = requestsRef.current[0]
      if (!request || respondingRequestId === request.requestId) {
        return
      }
      setRespondingRequestId(request.requestId)
      void window.api.browser
        .respondWebAuthnAccount({ requestId: request.requestId, credentialId })
        .then((accepted) => {
          if (accepted) {
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
      <BrowserWebAuthnAccountDialogSurface
        activeRequest={activeRequest}
        respondingRequestId={respondingRequestId}
        respond={respond}
      />
    </Suspense>
  )
}
