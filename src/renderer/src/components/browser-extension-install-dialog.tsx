import { Puzzle } from 'lucide-react'
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
import type { BrowserExtensionInstallPromptRequest } from '../../../shared/browser-extension-webstore'
import {
  describeBrowserExtensionAccess,
  describeUnsupportedBrowserExtensionFeatures
} from './browser-extension-permission-messages'
import { browserExtensionRemovalDescription } from './browser-extension-removal-description'

function InstallBody({
  request
}: {
  request: BrowserExtensionInstallPromptRequest
}): React.JSX.Element {
  const access = describeBrowserExtensionAccess(request.permissions, request.hostPermissions)
  const unsupported = describeUnsupportedBrowserExtensionFeatures(request.permissions)
  return (
    <div className="space-y-2">
      {access.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate(
            'browserExtensions.install.noAccess',
            'It does not ask to read or change data on websites.'
          )}
        </p>
      ) : (
        <>
          <p className="text-sm font-medium">
            {translate('browserExtensions.install.canHeading', 'It can:')}
          </p>
          <ul className="scrollbar-sleek max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-sm">
            {access.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </>
      )}
      {unsupported ? <p className="text-sm text-muted-foreground">{unsupported}</p> : null}
    </div>
  )
}

function promptDescription(request: BrowserExtensionInstallPromptRequest): string {
  if (request.kind === 'permissions') {
    return translate(
      'browserExtensions.permissions.description',
      'It is asking for access it did not have when you added it.'
    )
  }
  if (request.kind === 'uninstall') {
    // Why the Settings wording: removing from the store page removes it from every profile too.
    return browserExtensionRemovalDescription('webstore')
  }
  return request.profileLabel
    ? translate(
        'browserExtensions.install.profileDescription',
        'It runs in tabs that use the {{profile}} profile.',
        { profile: request.profileLabel }
      )
    : translate('browserExtensions.install.description', 'It runs in Orca browser tabs.')
}

/** Orca's confirmation for store installs and store-page removals; main waits on the answer. */
export function BrowserExtensionInstallDialog(): React.JSX.Element {
  const [requests, setRequests] = useState<BrowserExtensionInstallPromptRequest[]>([])
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null)
  const requestsRef = useRef(requests)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const setContextualToursBlockingSurfaceVisible = useAppStore(
    (state) => state.setContextualToursBlockingSurfaceVisible
  )
  const activeRequest = requests[0] ?? null
  const lastRequestRef = useRef(activeRequest)
  // Why: keep the last request on screen while the dialog animates closed.
  const displayed = activeRequest ?? lastRequestRef.current

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
    const stopRequests = window.api.browser.onExtensionInstallPrompt((request) => {
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

  const isInstall = displayed?.kind !== 'uninstall'
  const isPermissionRequest = displayed?.kind === 'permissions'
  const busy = displayed !== null && respondingRequestId === displayed.requestId
  const name = displayed?.name ?? ''

  return (
    <Dialog open={activeRequest !== null} onOpenChange={(open) => !open && respond(false)}>
      <DialogContent
        surface="security"
        showCloseButton={false}
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          confirmRef.current?.focus()
        }}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            {displayed?.iconDataUrl ? (
              <img src={displayed.iconDataUrl} alt="" className="size-10 shrink-0 rounded-md" />
            ) : (
              <Puzzle className="size-10 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 space-y-1">
              <DialogTitle className="break-words">
                {isPermissionRequest
                  ? translate(
                      'browserExtensions.permissions.title',
                      'Allow {{name}} more access?',
                      {
                        name
                      }
                    )
                  : isInstall
                    ? translate('browserExtensions.install.title', 'Add {{name}}?', { name })
                    : translate('browserExtensions.uninstall.title', 'Remove {{name}}?', { name })}
              </DialogTitle>
              <DialogDescription>
                {displayed ? promptDescription(displayed) : null}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {isInstall && displayed ? <InstallBody request={displayed} /> : null}

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => respond(false)}>
            {isPermissionRequest
              ? translate('browserExtensions.permissions.deny', 'Deny')
              : translate('browserExtensions.install.cancel', 'Cancel')}
          </Button>
          {isInstall ? (
            <Button ref={confirmRef} type="button" disabled={busy} onClick={() => respond(true)}>
              {isPermissionRequest
                ? translate('browserExtensions.permissions.confirm', 'Allow')
                : translate('browserExtensions.install.confirm', 'Add extension')}
            </Button>
          ) : (
            <Button
              ref={confirmRef}
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => respond(true)}
            >
              {translate('browserExtensions.uninstall.confirm', 'Remove')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
