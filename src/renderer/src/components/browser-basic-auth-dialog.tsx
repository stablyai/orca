import { LockKeyhole } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { BrowserBasicAuthRequest } from '../../../shared/browser-basic-auth'

export function BrowserBasicAuthDialog(): React.JSX.Element {
  const [requests, setRequests] = useState<BrowserBasicAuthRequest[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null)
  const requestsRef = useRef(requests)
  const usernameInputRef = useRef<HTMLInputElement | null>(null)
  const setContextualToursBlockingSurfaceVisible = useAppStore(
    (state) => state.setContextualToursBlockingSurfaceVisible
  )
  const activeRequest = requests[0] ?? null

  useEffect(() => {
    requestsRef.current = requests
  }, [requests])

  const removeRequest = useCallback((requestId: string) => {
    // Why only for the active request: the fields must never survive into a
    // different host's challenge — clearing when the ACTIVE request leaves the
    // queue guarantees the next queued challenge starts empty — but a QUEUED
    // challenge closing in the background (timeout, teardown) must not wipe
    // credentials being typed into the active one.
    if (requestsRef.current[0]?.requestId === requestId) {
      setUsername('')
      setPassword('')
    }
    setRequests((current) => current.filter((request) => request.requestId !== requestId))
    setRespondingRequestId((current) => (current === requestId ? null : current))
  }, [])

  useEffect(() => {
    const stopRequests = window.api.browser.onBasicAuthRequest((request) => {
      setRequests((current) => [...current, request])
    })
    const stopClosures = window.api.browser.onBasicAuthRequestClosed(({ requestId }) => {
      removeRequest(requestId)
    })
    return () => {
      stopRequests()
      stopClosures()
      for (const request of requestsRef.current) {
        void window.api.browser
          .respondBasicAuth({ requestId: request.requestId, cancelled: true })
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
    const focusTimer = setTimeout(() => usernameInputRef.current?.focus())
    return () => clearTimeout(focusTimer)
  }, [activeRequest])

  const respond = useCallback(
    (credentials: { username: string; password: string } | null) => {
      const request = requestsRef.current[0]
      if (!request || respondingRequestId === request.requestId) {
        return
      }
      setRespondingRequestId(request.requestId)
      void window.api.browser
        .respondBasicAuth(
          credentials
            ? {
                requestId: request.requestId,
                cancelled: false,
                username: credentials.username,
                password: credentials.password
              }
            : { requestId: request.requestId, cancelled: true }
        )
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

  // Why protocol from the payload: authInfo.scheme names the auth method
  // ("basic"), not the site's scheme; the protocol comes from the challenged
  // page's URL in the login event. A port is hidden only when it is the
  // protocol's default.
  const protocol = activeRequest?.protocol
  const isDefaultPort =
    protocol === 'https'
      ? activeRequest?.port === 443
      : protocol === 'http'
        ? activeRequest?.port === 80
        : false
  const siteLabel = activeRequest
    ? `${protocol ? `${protocol}://` : ''}${activeRequest.host}${
        isDefaultPort ? '' : `:${activeRequest.port}`
      }`
    : null
  const busy = activeRequest !== null && respondingRequestId === activeRequest.requestId

  return (
    <Dialog open={activeRequest !== null} onOpenChange={(open) => !open && respond(null)}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.browser.basicAuth.title', 'Sign in')}
          </DialogTitle>
          <DialogDescription>
            {activeRequest?.realm
              ? translate(
                  'auto.components.browser.basicAuth.realmDescription',
                  'This site says: "{{value0}}" — enter your credentials to continue.',
                  { value0: activeRequest.realm }
                )
              : translate(
                  'auto.components.browser.basicAuth.description',
                  'This site requires a username and password to continue.'
                )}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            respond({ username, password })
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="browser-basic-auth-username">
              {translate('auto.components.browser.basicAuth.username', 'Username')}
            </Label>
            <Input
              id="browser-basic-auth-username"
              ref={usernameInputRef}
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="browser-basic-auth-password">
              {translate('auto.components.browser.basicAuth.password', 'Password')}
            </Label>
            <Input
              id="browser-basic-auth-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => respond(null)}>
              {translate('auto.components.browser.basicAuth.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              <LockKeyhole className="size-4" />
              {translate('auto.components.browser.basicAuth.signIn', 'Sign in')}
            </Button>
          </DialogFooter>
        </form>

        {siteLabel ? (
          <p className="text-xs text-muted-foreground">
            {translate('auto.components.browser.basicAuth.site', 'Site')}{' '}
            <span className="font-mono text-foreground">{siteLabel}</span>
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
