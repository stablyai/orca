import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { ExternalLink, Settings } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

type LinkRoutingPreferenceDialogOptions = {
  url?: string
  preview?: boolean
  openLinksInAppDefault?: boolean
}

type LinkRoutingPreferenceDialogRequest = {
  id: number
  options: LinkRoutingPreferenceDialogOptions
  resolve: (openInOrca: boolean) => void
}

type LinkRoutingPreferenceDialogContextValue = (
  options?: LinkRoutingPreferenceDialogOptions
) => Promise<boolean>

const PREVIEW_STORAGE_KEY = 'orca.previewLinkRoutingPreferenceDialog'
const PREVIEW_DEFAULT_STORAGE_KEY = `${PREVIEW_STORAGE_KEY}.default`
const LinkRoutingPreferenceDialogContext =
  createContext<LinkRoutingPreferenceDialogContextValue | null>(null)

function displayHostForUrl(url: string | undefined): string | null {
  if (!url) {
    return null
  }
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

export function LinkRoutingPreferenceDialogProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
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
  const displayHost = displayHostForUrl(displayedRequest?.options.url)
  const openLinksInAppDefault = displayedRequest?.options.openLinksInAppDefault === true
  const isMac = navigator.userAgent.includes('Mac')
  const systemBrowserShortcutKeys = isMac ? ['⇧', '⌘'] : ['Shift', 'Ctrl']

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
        <DialogContent
          showCloseButton={false}
          overlayClassName="!z-[140]"
          className="!z-[150] gap-4 p-0 sm:max-w-[520px]"
        >
          <div className="rounded-t-lg border-b border-border bg-muted/30 px-6 pt-5 pb-4">
            <DialogHeader className="gap-3">
              <div className="flex items-center justify-between gap-3">
                <Badge variant="outline" className="bg-background/70 text-muted-foreground">
                  {translate(
                    'auto.components.link.routing.preference.dialog.badge',
                    'Terminal link'
                  )}
                </Badge>
                {displayedRequest?.options.preview ? (
                  <Badge variant="secondary">
                    {translate('auto.components.link.routing.preference.dialog.preview', 'Preview')}
                  </Badge>
                ) : null}
              </div>
              <div className="space-y-2">
                <DialogTitle className="text-xl leading-tight">
                  {openLinksInAppDefault
                    ? translate(
                        'auto.components.link.routing.preference.dialog.keep.title',
                        "Keep terminal links in Orca's browser?"
                      )
                    : translate(
                        'auto.components.link.routing.preference.dialog.title',
                        "Open terminal links in Orca's browser?"
                      )}
                </DialogTitle>
                <DialogDescription className="text-sm leading-relaxed">
                  {openLinksInAppDefault
                    ? translate(
                        'auto.components.link.routing.preference.dialog.keep.description',
                        'Or use your system browser by default.'
                      )
                    : translate(
                        'auto.components.link.routing.preference.dialog.description',
                        "Use Orca's browser for terminal links, or keep your system browser."
                      )}
                </DialogDescription>
              </div>
            </DialogHeader>
          </div>

          <div className="space-y-3 px-6">
            {displayHost ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {translate('auto.components.link.routing.preference.dialog.link.label', 'Link')}
                </span>
                <span className="rounded-md border border-border bg-muted/30 px-2 py-1 font-mono">
                  {displayHost}
                </span>
              </div>
            ) : null}

            <div className="flex gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
              <Settings className="mt-0.5 size-3.5 shrink-0" />
              <div className="space-y-1">
                <p>
                  {translate(
                    'auto.components.link.routing.preference.dialog.orca.note',
                    'Orca can use imported cookies for logged-in sites.'
                  )}
                </p>
                <p>
                  {translate(
                    'auto.components.link.routing.preference.dialog.settings.note',
                    'Change this later in Settings → Browser.'
                  )}
                </p>
                <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <span>
                    {translate(
                      'auto.components.link.routing.preference.dialog.shortcut.note.prefix',
                      'When links open in Orca,'
                    )}
                  </span>
                  <ShortcutKeyCombo
                    keys={systemBrowserShortcutKeys}
                    keyCapClassName="min-w-0 px-1 py-0 text-[10px] shadow-none"
                    separatorClassName="text-[10px] text-muted-foreground"
                  />
                  <span>
                    {translate(
                      'auto.components.link.routing.preference.dialog.shortcut.note.suffix',
                      'click opens system browser once.'
                    )}
                  </span>
                </p>
              </div>
            </div>
          </div>

          <DialogFooter className="border-t border-border bg-muted/20 px-6 py-4 sm:justify-between">
            <Button variant="outline" onClick={() => settleActiveRequest(false)}>
              <ExternalLink className="size-4" />
              {translate(
                'auto.components.link.routing.preference.dialog.system.button',
                'Use system browser'
              )}
            </Button>
            <Button autoFocus onClick={() => settleActiveRequest(true)}>
              {openLinksInAppDefault
                ? translate(
                    'auto.components.link.routing.preference.dialog.keep.orca.button',
                    'Keep Orca'
                  )
                : translate(
                    'auto.components.link.routing.preference.dialog.orca.button',
                    'Open in Orca'
                  )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LinkRoutingPreferenceDialogContext.Provider>
  )
}

export function useLinkRoutingPreferenceDialog(): LinkRoutingPreferenceDialogContextValue {
  const requestPreference = useContext(LinkRoutingPreferenceDialogContext)
  if (!requestPreference) {
    throw new Error(
      'useLinkRoutingPreferenceDialog must be used inside LinkRoutingPreferenceDialogProvider'
    )
  }
  return requestPreference
}
