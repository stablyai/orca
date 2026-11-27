import { KeyRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

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
import type {
  BrowserWebAuthnAccount,
  BrowserWebAuthnAccountRequest
} from '../../../../../shared/browser/prompts/browser-webauthn-account'

function accountLabels(
  account: BrowserWebAuthnAccount,
  index: number,
  t: Translate = translate
): { primary: string; secondary: string | null } {
  const primary =
    account.displayName?.trim() ||
    account.name?.trim() ||
    `${t('auto.components.browser.webauthn.account.fallback', 'Passkey')} ${index + 1}`
  const secondary = account.name?.trim()
  return { primary, secondary: secondary && secondary !== primary ? secondary : null }
}

export function BrowserWebAuthnAccountDialogSurface({
  activeRequest,
  respondingRequestId,
  respond
}: {
  activeRequest: BrowserWebAuthnAccountRequest | null
  respondingRequestId: string | null
  respond: (credentialId: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const firstAccountRef = useRef<HTMLButtonElement | null>(null)
  // Keep the last request on screen while the dialog animates closed.
  const [lastRequest, setLastRequest] = useState(activeRequest)
  if (activeRequest && activeRequest !== lastRequest) {
    setLastRequest(activeRequest)
  }
  const displayedRequest = activeRequest ?? lastRequest

  useEffect(() => {
    if (!activeRequest) {
      return
    }
    const focusTimer = setTimeout(() => firstAccountRef.current?.focus())
    return () => clearTimeout(focusTimer)
  }, [activeRequest])

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
            {t('auto.components.browser.webauthn.account.title', 'Choose a passkey')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.browser.webauthn.account.description',
              'Choose the account to use with this security key.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {displayedRequest?.accounts.map((account, index) => {
            const labels = accountLabels(account, index, t)
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
          {t('auto.components.browser.webauthn.account.site', 'Site')}{' '}
          <span className="font-mono text-foreground">{displayedRequest?.relyingPartyId}</span>
        </p>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => respond(null)}>
            {t('auto.components.browser.webauthn.account.cancel', 'Cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
