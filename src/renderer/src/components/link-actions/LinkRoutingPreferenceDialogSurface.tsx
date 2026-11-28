import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { LinkRoutingPreferenceDialogOptions } from './link-routing-preference-dialog-context'

export type LinkRoutingPreferenceDialogRequest = {
  id: number
  options: LinkRoutingPreferenceDialogOptions
  resolve: (openInOrca: boolean) => void
}

export function LinkRoutingPreferenceDialogSurface({
  activeRequest,
  onSettle
}: {
  activeRequest: LinkRoutingPreferenceDialogRequest | null
  onSettle: (request: LinkRoutingPreferenceDialogRequest, openInOrca: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [lastDisplayedRequest, setLastDisplayedRequest] =
    useState<LinkRoutingPreferenceDialogRequest | null>(activeRequest)
  if (activeRequest && activeRequest !== lastDisplayedRequest) {
    setLastDisplayedRequest(activeRequest)
  }
  // Why: Radix keeps dialog content mounted while closing; keep copy stable during exit animation.
  const displayedRequest = activeRequest ?? lastDisplayedRequest
  const openLinksInAppDefault = displayedRequest?.options.openLinksInAppDefault === true
  const isMac = navigator.userAgent.includes('Mac')
  const systemBrowserShortcut = isMac ? '⇧⌘' : 'Shift+Ctrl'

  const settle = (openInOrca: boolean): void => {
    if (activeRequest) {
      onSettle(activeRequest, openInOrca)
    }
  }

  return (
    <Dialog open={activeRequest !== null} onOpenChange={(open) => !open && settle(false)}>
      <DialogContent size="confirm" overlayClassName="!z-[140]" className="!z-[150]">
        <DialogHeader>
          <DialogTitle>
            {openLinksInAppDefault
              ? t(
                  'components.link.routing.preference.dialog.keepInOrcaTitle',
                  'Keep terminal links in Orca?'
                )
              : t(
                  'components.link.routing.preference.dialog.openInOrcaTitle',
                  'Open terminal links in Orca?'
                )}
          </DialogTitle>
          <DialogDescription>
            {t(
              'components.link.routing.preference.dialog.shortcutSummary',
              '{{shortcut}}-click opens your system browser once. Change this in Settings.',
              { shortcut: systemBrowserShortcut }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => settle(false)}>
            {t(
              'auto.components.link.routing.preference.dialog.system.button',
              'Use system browser'
            )}
          </Button>
          <Button size="sm" autoFocus onClick={() => settle(true)}>
            {openLinksInAppDefault
              ? t('auto.components.link.routing.preference.dialog.keep.orca.button', 'Keep Orca')
              : t('auto.components.link.routing.preference.dialog.orca.button', 'Open in Orca')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
