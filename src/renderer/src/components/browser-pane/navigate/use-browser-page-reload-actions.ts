import type { BrowserPageInitializationAction } from '../../../../../shared/browser/client-hosting/browser-page-initialization-action'
import { useCallback, useMemo, useState, type MutableRefObject } from 'react'
import { useShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { useTranslate } from '@/i18n/use-translate'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import {
  type BrowserReloadTrigger,
  reloadBrowserPageWebview,
  resolveBrowserReloadButtonLabelKind,
  resolveBrowserReloadIntent
} from './browser-reload-action'
import { retryBrowserTabLoad } from '../describe-page/browser-page-url-display'
import type { BrowserTabPageState } from '../describe-page/browser-page-types'
import { useChangedFilePageRefresh } from '@/lib/browser/refresh/use-changed-file-page-refresh'
import { sameDocumentUrl } from '@/lib/browser/refresh/changed-file-page-refresh-driver'

/** `not-ready`: a live guest that cannot take the command yet. */
type BrowserReloadTriggerResult = 'issued' | 'not-ready'

export function useBrowserPageReloadActions({
  browserTab,
  onInitializationAction,
  webviewRef,
  retryGuestRecoveryRef,
  onUpdatePageStateRef,
  navigateToUrl
}: {
  browserTab: BrowserPageState
  onInitializationAction?: (action: BrowserPageInitializationAction) => void
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  retryGuestRecoveryRef: MutableRefObject<() => void>
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
  /** A page that owns its local guest also satisfies explicit-reopen refreshes through it. */
  navigateToUrl?: (url: string) => void
}): {
  reloadWebviewOrRecoverGuest: (ignoreCache: boolean) => BrowserReloadTriggerResult
  runReloadTrigger: (trigger: BrowserReloadTrigger) => BrowserReloadTriggerResult
  reloadButtonLabel: string
  reloadButtonLabelKind: ReturnType<typeof resolveBrowserReloadButtonLabelKind>
  reloadMenuOpen: boolean
  setReloadMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  reloadShortcut: string
  hardReloadShortcut: string
} {
  const t = useTranslate()
  const reloadShortcut = useShortcutLabel('browser.reload')
  const hardReloadShortcut = useShortcutLabel('browser.hardReload')
  const [reloadMenuOpen, setReloadMenuOpen] = useState(false)
  const reloadState = useMemo(
    () => ({ loading: browserTab.loading, loadErrorCode: browserTab.loadError?.code ?? null }),
    [browserTab.loading, browserTab.loadError]
  )
  // Stable so shortcut listeners don't re-register on every page-state update.
  const reloadWebviewOrRecoverGuest = useLatestHandler(
    (ignoreCache: boolean): BrowserReloadTriggerResult => {
      if (onInitializationAction) {
        onInitializationAction({ type: 'navigate', url: browserTab.url })
        return 'issued'
      }
      const webview = webviewRef.current
      if (!webview) {
        return 'not-ready'
      }
      const result = reloadBrowserPageWebview(webview, { ignoreCache })
      if (result === 'not-ready') {
        return 'not-ready'
      }
      if (result === 'nothing-to-reload') {
        retryBrowserTabLoad(webview, browserTab, onUpdatePageStateRef.current)
        return 'issued'
      }
      onUpdatePageStateRef.current(browserTab.id, { loading: true })
      if (result === 'guest-missing') {
        // Why: reload cannot revive a destroyed guest (STA-3448) — recreate it instead.
        retryGuestRecoveryRef.current()
      }
      return 'issued'
    }
  )
  const runReloadTrigger = useCallback(
    (trigger: BrowserReloadTrigger): BrowserReloadTriggerResult => {
      if (onInitializationAction) {
        onInitializationAction(
          resolveBrowserReloadIntent(trigger, reloadState) === 'stop'
            ? { type: 'stop' }
            : { type: 'navigate', url: browserTab.url }
        )
        return 'issued'
      }
      const webview = webviewRef.current
      if (!webview) {
        return 'not-ready'
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
          return reloadWebviewOrRecoverGuest(true)
        case 'reload':
          return reloadWebviewOrRecoverGuest(false)
      }
      return 'issued'
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

  useChangedFilePageRefresh(navigateToUrl ? browserTab.id : null, {
    readWebview: () => webviewRef.current,
    pointsAtResource: (resource) =>
      resource.kind === 'local-file' && browserTab.url === resource.url,
    isResourceUrl: (url, resource) =>
      resource.kind === 'local-file' && sameDocumentUrl(url, resource.url),
    reload: () => runReloadTrigger('reload'),
    navigate: (resource) => {
      if (!navigateToUrl || resource.kind !== 'local-file') {
        return 'failed'
      }
      navigateToUrl(resource.url)
      return 'issued'
    }
  })

  const reloadButtonLabelKind = resolveBrowserReloadButtonLabelKind(reloadState)
  const reloadButtonLabel =
    reloadButtonLabelKind === 'stop'
      ? t('auto.components.browser.pane.BrowserPane.b7e4d9c1a2', 'Stop')
      : reloadButtonLabelKind === 'retry'
        ? t('auto.components.browser.pane.BrowserPane.781d6459ad', 'Retry')
        : t('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')

  return {
    reloadWebviewOrRecoverGuest,
    runReloadTrigger,
    reloadButtonLabel,
    reloadButtonLabelKind,
    reloadMenuOpen,
    setReloadMenuOpen,
    reloadShortcut,
    hardReloadShortcut
  }
}
