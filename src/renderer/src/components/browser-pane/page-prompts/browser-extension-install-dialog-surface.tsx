import { Puzzle } from 'lucide-react'
import { useRef, useState } from 'react'

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
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { translateBrowserSessionProfileLabel } from '@/lib/browser/profiles/browser-session-profile-label'
import type { BrowserExtensionInstallPromptRequest } from '../../../../../shared/browser/extensions/browser-extension-webstore'
import {
  describeBrowserExtensionAccess,
  describeUnsupportedBrowserExtensionFeatures
} from '../assemble-chrome/extensions/browser-extension-permission-messages'
import { browserExtensionRemovalDescription } from '../assemble-chrome/extensions/browser-extension-removal-description'

function InstallBody({
  request
}: {
  request: BrowserExtensionInstallPromptRequest
}): React.JSX.Element {
  const t = useTranslate()
  const access = describeBrowserExtensionAccess(request.permissions, request.hostPermissions, t)
  const unsupported = describeUnsupportedBrowserExtensionFeatures(request.permissions, t)
  return (
    <div className="space-y-2">
      {access.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(
            'browserExtensions.install.noAccess',
            'It does not ask to read or change data on websites.'
          )}
        </p>
      ) : (
        <>
          <p className="text-sm font-medium">
            {t('browserExtensions.install.canHeading', 'It can:')}
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

function promptDescription(
  request: BrowserExtensionInstallPromptRequest,
  t: Translate = translate
): string {
  if (request.kind === 'permissions') {
    return t(
      'browserExtensions.permissions.description',
      'It is asking for access it did not have when you added it.'
    )
  }
  if (request.kind === 'uninstall') {
    // Why the Settings wording: removing from the store page removes it from every profile too.
    return browserExtensionRemovalDescription('webstore', t)
  }
  return request.profileLabel
    ? t(
        'browserExtensions.install.profileDescription',
        'It runs in tabs that use the {{profile}} profile.',
        { profile: translateBrowserSessionProfileLabel(request.profileLabel) }
      )
    : t('browserExtensions.install.description', 'It runs in Orca browser tabs.')
}

export function BrowserExtensionInstallDialogSurface({
  activeRequest,
  respondingRequestId,
  respond
}: {
  activeRequest: BrowserExtensionInstallPromptRequest | null
  respondingRequestId: string | null
  respond: (accepted: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  // Keep the last request on screen while the dialog animates closed.
  const [lastRequest, setLastRequest] = useState(activeRequest)
  if (activeRequest && activeRequest !== lastRequest) {
    setLastRequest(activeRequest)
  }
  const displayed = activeRequest ?? lastRequest

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
                  ? t('browserExtensions.permissions.title', 'Allow {{name}} more access?', {
                      name
                    })
                  : isInstall
                    ? t('browserExtensions.install.title', 'Add {{name}}?', { name })
                    : t('browserExtensions.uninstall.title', 'Remove {{name}}?', { name })}
              </DialogTitle>
              <DialogDescription>
                {displayed ? promptDescription(displayed, t) : null}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {isInstall && displayed ? <InstallBody request={displayed} /> : null}

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => respond(false)}>
            {isPermissionRequest
              ? t('browserExtensions.permissions.deny', 'Deny')
              : t('browserExtensions.install.cancel', 'Cancel')}
          </Button>
          {isInstall ? (
            <Button ref={confirmRef} type="button" disabled={busy} onClick={() => respond(true)}>
              {isPermissionRequest
                ? t('browserExtensions.permissions.confirm', 'Allow')
                : t('browserExtensions.install.confirm', 'Add extension')}
            </Button>
          ) : (
            <Button
              ref={confirmRef}
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => respond(true)}
            >
              {t('browserExtensions.uninstall.confirm', 'Remove')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
