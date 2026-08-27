import { KeyRound } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type {
  BrowserWebAuthnAccount,
  BrowserWebAuthnAccountRequest
} from '../../../shared/browser-webauthn-account'

function accountLabels(
  account: BrowserWebAuthnAccount,
  index: number
): { primary: string; secondary: string | null } {
  const primary =
    account.displayName?.trim() ||
    account.name?.trim() ||
    `${translate('auto.components.browser.webauthn.account.fallback', 'Passkey')} ${index + 1}`
  const secondary = account.name?.trim()
  return { primary, secondary: secondary && secondary !== primary ? secondary : null }
}

export function BrowserWebAuthnAccountDialog(): React.JSX.Element {
  const [requests, setRequests] = useState<BrowserWebAuthnAccountRequest[]>([])
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null)
  const requestsRef = useRef(requests)
  const firstAccountRef = useRef<HTMLButtonElement | null>(null)
  const setContextualToursBlockingSurfaceVisible = useAppStore(
    (state) => state.setContextualToursBlockingSurfaceVisible
  )
  const activeRequest = requests[0] ?? null
  const lastRequestRef = useRef(activeRequest)
  const displayedRequest = activeRequest ?? lastRequestRef.current

  useEffect(() => {
    requestsRef.current = requests
    if (activeRequest) {
      lastRequestRef.current = activeRequest
    }
  }, [activeRequest, requests])

  const removeRequest = useCallback((requestId: string) => {
    setRequests((current) => current.filter((request) => request.requestId !== requestId))
    setRespondingRequestId((current) => (current === requestId ? null : current))
  }, [])

  useEffect(() => {
    const stopRequests = window.api.browser.onWebAuthnAccountRequest((request) => {
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

  useEffect(() => {
    if (!activeRequest) {
      return
    }
    const focusTimer = setTimeout(() => firstAccountRef.current?.focus())
    return () => clearTimeout(focusTimer)
  }, [activeRequest])

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

  return (
    <Dialog open={activeRequest !== null} onOpenChange={(open) => !open && respond(null)}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          firstAccountRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.browser.webauthn.account.title', 'Choose a passkey')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.browser.webauthn.account.description',
              'Choose the account to use with this security key.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {displayedRequest?.accounts.map((account, index) => {
            const labels = accountLabels(account, index)
            return (
              <Button
                key={account.credentialId}
                ref={index === 0 ? firstAccountRef : undefined}
                autoFocus={index === 0}
                type="button"
                variant="outline"
                className="h-auto w-full justify-start gap-3 px-3 py-3 text-left"
                disabled={respondingRequestId === displayedRequest.requestId}
                onClick={() => respond(account.credentialId)}
              >
                <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{labels.primary}</span>
                  {labels.secondary ? (
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      {labels.secondary}
                    </span>
                  ) : null}
                </span>
              </Button>
            )
          })}
        </div>

        <p className="text-xs text-muted-foreground">
          {translate('auto.components.browser.webauthn.account.site', 'Site')}{' '}
          <span className="font-mono text-foreground">{displayedRequest?.relyingPartyId}</span>
        </p>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => respond(null)}>
            {translate('auto.components.browser.webauthn.account.cancel', 'Cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
