import React, { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import {
  LinkRoutingPreferenceDialogContext,
  type LinkRoutingPreferenceDialogContextValue,
  type LinkRoutingPreferenceDialogOptions
} from './link-routing-preference-dialog-context'

type LinkRoutingPreferenceDialogRequest = {
  id: number
  options: LinkRoutingPreferenceDialogOptions
  resolve: (openInOrca: boolean) => void
}

const PREVIEW_STORAGE_KEY = 'orca.previewLinkRoutingPreferenceDialog'
const PREVIEW_DEFAULT_STORAGE_KEY = `${PREVIEW_STORAGE_KEY}.default`

export function LinkRoutingPreferenceDialogProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const nextIdRef = useRef(0)
  const [queue, setQueue] = useState<LinkRoutingPreferenceDialogRequest[]>([])
  const activeRequest = queue[0] ?? null
  const activeRequestRef = useRef<LinkRoutingPreferenceDialogRequest | null>(activeRequest)
  const setContextualToursBlockingSurfaceVisible = useAppStore(
    (s) => s.setContextualToursBlockingSurfaceVisible
  )
  const lastDisplayedRequestRef = useRef<LinkRoutingPreferenceDialogRequest | null>(activeRequest)
  activeRequestRef.current = activeRequest
  if (activeRequest) {
    lastDisplayedRequestRef.current = activeRequest
  }
  // Why: Radix keeps dialog content mounted while closing; keep copy stable during exit animation.
  const displayedRequest = activeRequest ?? lastDisplayedRequestRef.current
  const openLinksInAppDefault = displayedRequest?.options.openLinksInAppDefault === true
  const isMac = navigator.userAgent.includes('Mac')
  const systemBrowserShortcut = isMac ? '⇧⌘' : 'Shift+Ctrl'

  useEffect(() => {
    setContextualToursBlockingSurfaceVisible(activeRequest !== null)
    return () => setContextualToursBlockingSurfaceVisible(false)
  }, [activeRequest, setContextualToursBlockingSurfaceVisible])

  const requestPreference = useCallback<LinkRoutingPreferenceDialogContextValue>((options = {}) => {
    return new Promise((resolve) => {
      const request: LinkRoutingPreferenceDialogRequest = {
        id: nextIdRef.current,
        options,
        resolve
      }
      nextIdRef.current += 1
      setQueue((currentQueue) => [...currentQueue, request])
    })
  }, [])

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === 'undefined') {
      return
    }
    if (window.sessionStorage.getItem(PREVIEW_STORAGE_KEY) !== '1') {
      return
    }
    const previewDefault = window.sessionStorage.getItem(PREVIEW_DEFAULT_STORAGE_KEY)
    window.sessionStorage.removeItem(PREVIEW_STORAGE_KEY)
    window.sessionStorage.removeItem(PREVIEW_DEFAULT_STORAGE_KEY)
    void requestPreference({
      openLinksInAppDefault: previewDefault === 'orca',
      preview: true,
      url: 'https://github.com/stablyai/orca/pull/1234'
    })
  }, [requestPreference])

  const settleActiveRequest = useCallback((openInOrca: boolean) => {
    const request = activeRequestRef.current
    if (!request) {
      return
    }
    request.resolve(openInOrca)
    setQueue((currentQueue) => {
      if (currentQueue[0]?.id === request.id) {
        return currentQueue.slice(1)
      }
      return currentQueue.filter((queuedRequest) => queuedRequest.id !== request.id)
    })
  }, [])

  return (
    <LinkRoutingPreferenceDialogContext.Provider value={requestPreference}>
      {children}
      <Dialog
        open={activeRequest !== null}
        onOpenChange={(open) => !open && settleActiveRequest(false)}
      >
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
            <Button variant="outline" size="sm" onClick={() => settleActiveRequest(false)}>
              {t(
                'auto.components.link.routing.preference.dialog.system.button',
                'Use system browser'
              )}
            </Button>
            <Button size="sm" autoFocus onClick={() => settleActiveRequest(true)}>
              {openLinksInAppDefault
                ? t('auto.components.link.routing.preference.dialog.keep.orca.button', 'Keep Orca')
                : t('auto.components.link.routing.preference.dialog.orca.button', 'Open in Orca')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LinkRoutingPreferenceDialogContext.Provider>
  )
}
