import type { BrowserPageInitializationAction } from '../../../../../shared/browser/client-hosting/browser-page-initialization-action'
import { useCallback, useMemo, useState, type MutableRefObject } from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { useBrowserReloadControlLabels } from './use-browser-reload-control-labels'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import {
  type BrowserReloadTrigger,
  reloadBrowserPageWebview,
  resolveBrowserReloadIntent
} from './browser-reload-action'
import { retryBrowserTabLoad } from '../describe-page/browser-page-url-display'
import type { BrowserTabPageState } from '../describe-page/browser-page-types'
import { isBrowserPageAttachWaiting } from '../host-guest/lifecycle/browser-page-deferred-attach'

export function useBrowserPageReloadActions({
  browserTab,
  onInitializationAction,
  webviewRef,
  retryGuestRecoveryRef,
  onUpdatePageStateRef
}: {
  browserTab: BrowserPageState
  onInitializationAction?: (action: BrowserPageInitializationAction) => void
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  retryGuestRecoveryRef: MutableRefObject<() => void>
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
}): {
  reloadWebviewOrRecoverGuest: (ignoreCache: boolean) => void
  runReloadTrigger: (trigger: BrowserReloadTrigger) => void
  reloadButtonLabel: string
  reloadButtonLabelKind: ReturnType<typeof useBrowserReloadControlLabels>['reloadButtonLabelKind']
  reloadMenuOpen: boolean
  setReloadMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  reloadShortcut: string
  hardReloadShortcut: string
} {
  const [reloadMenuOpen, setReloadMenuOpen] = useState(false)
  const reloadState = useMemo(
    () => ({ loading: browserTab.loading, loadErrorCode: browserTab.loadError?.code ?? null }),
    [browserTab.loading, browserTab.loadError]
  )
  // Stable so shortcut listeners don't re-register on every page-state update.
  const reloadWebviewOrRecoverGuest = useLatestHandler((ignoreCache: boolean) => {
    if (onInitializationAction) {
      onInitializationAction({ type: 'navigate', url: browserTab.url })
      return
    }
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    const result = reloadBrowserPageWebview(webview, { ignoreCache })
    if (result === 'not-ready') {
      return
    }
    if (result === 'nothing-to-reload') {
      retryBrowserTabLoad(webview, browserTab, onUpdatePageStateRef.current)
      return
    }
    onUpdatePageStateRef.current(browserTab.id, { loading: true })
    if (result === 'guest-missing') {
      // Why: reload cannot revive a destroyed guest (STA-3448) — recreate it instead.
      retryGuestRecoveryRef.current()
    }
  })
  const runReloadTrigger = useCallback(
    (trigger: BrowserReloadTrigger) => {
      if (onInitializationAction) {
        onInitializationAction(
          resolveBrowserReloadIntent(trigger, reloadState) === 'stop'
            ? { type: 'stop' }
            : { type: 'navigate', url: browserTab.url }
        )
        return
      }
      const webview = webviewRef.current
      // No page yet while it waits for its profile's extensions (at most 5 s): nothing to stop or reload.
      if (!webview || isBrowserPageAttachWaiting(webview)) {
        return
      }
      switch (resolveBrowserReloadIntent(trigger, reloadState)) {
        case 'stop':
          webview.stop()
          break
        case 'retry-guest-recovery':
          onUpdatePageStateRef.current(browserTab.id, { loading: true })
          retryGuestRecoveryRef.current()
          break
        case 'retry-load':
          retryBrowserTabLoad(webview, browserTab, onUpdatePageStateRef.current)
          break
        case 'hard-reload':
          reloadWebviewOrRecoverGuest(true)
          break
        case 'reload':
          reloadWebviewOrRecoverGuest(false)
          break
      }
    },
    [
      browserTab,
      onInitializationAction,
      onUpdatePageStateRef,
      reloadState,
      reloadWebviewOrRecoverGuest,
      retryGuestRecoveryRef,
      webviewRef
    ]
  )

  return {
    reloadWebviewOrRecoverGuest,
    runReloadTrigger,
    ...useBrowserReloadControlLabels(reloadState),
    reloadMenuOpen,
    setReloadMenuOpen
  }
}
