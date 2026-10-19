import { useEffect } from 'react'
import { toast } from 'sonner'
import type { BrowserExternalAppRequest } from '../../../../shared/browser-external-app'
import {
  useConfirmationDialog,
  type ConfirmationDialogContextValue
} from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'

function confirmExternalApp(
  confirm: ConfirmationDialogContextValue,
  { appName, scheme, origin }: BrowserExternalAppRequest,
  signal: AbortSignal
): Promise<boolean> {
  return confirm({
    signal,
    title: appName
      ? translate('auto.components.browserPane.externalApp.title', 'Open {{app}}?', {
          app: appName
        })
      : translate(
          'auto.components.browserPane.externalApp.schemeTitle',
          'Open this {{scheme}} link?',
          {
            scheme
          }
        ),
    description: origin
      ? translate(
          'auto.components.browserPane.externalApp.description',
          '{{origin}} wants to open another application.',
          { origin }
        )
      : translate(
          'auto.components.browserPane.externalApp.anonymousDescription',
          'A page in the browser wants to open another application.'
        ),
    descriptionClassName: 'break-all',
    confirmLabel: appName
      ? translate('auto.components.browserPane.externalApp.confirm', 'Open {{app}}', {
          app: appName
        })
      : translate('auto.components.browserPane.externalApp.confirmLink', 'Open link'),
    cancelLabel: translate('auto.components.browserPane.externalApp.cancel', 'Cancel')
  })
}

export function subscribeBrowserExternalAppConfirmation(
  confirm: ConfirmationDialogContextValue
): () => void {
  if (typeof window.api.browser?.onExternalAppRequest !== 'function') {
    return () => {}
  }
  const prompts = new Map<string, AbortController>()
  const unsubscribeClosed = window.api.browser.onExternalAppRequestClosed(({ requestId }) =>
    prompts.get(requestId)?.abort()
  )
  const unsubscribeRequests = window.api.browser.onExternalAppRequest((request) => {
    const prompt = new AbortController()
    prompts.set(request.requestId, prompt)
    void confirmExternalApp(confirm, request, prompt.signal).then(async (open) => {
      prompts.delete(request.requestId)
      if (prompt.signal.aborted) {
        return
      }
      const result = await window.api.browser.respondExternalApp({
        requestId: request.requestId,
        open
      })
      if (result === 'launch-failed') {
        // Why: the user chose Open, so a silent failure would read as the click doing nothing.
        toast.error(
          translate(
            'auto.components.browserPane.externalApp.launchFailed',
            "Couldn't open an app for this {{scheme}} link. It may not be installed.",
            { scheme: request.scheme }
          )
        )
      }
    })
  })
  return () => {
    unsubscribeRequests()
    unsubscribeClosed()
  }
}

export function BrowserExternalAppConfirmation(): null {
  const confirm = useConfirmationDialog()
  useEffect(() => subscribeBrowserExternalAppConfirmation(confirm), [confirm])
  return null
}
