import { useEffect, type MutableRefObject } from 'react'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import { browserChromeShortcutOwnsEvent } from '../describe-page/browser-overlay-shortcut-target'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { isEditableKeyboardTarget } from './browser-keyboard'
import {
  addBrowserPageZoomEventListener,
  applyBrowserPageZoom,
  rememberExplicitBrowserPageZoomLevel,
  type BrowserPageZoomCommand,
  type BrowserPageZoomDirection
} from './browser-page-zoom'

/**
 * History, reload and zoom chords for a <webview>-backed pane — local and client-hosted alike.
 * Each one is handled twice: once for chrome focus, where the chord never leaves the renderer,
 * and once for the IPC main forwards when the guest (its own Chromium process) holds focus.
 */
export function useBrowserPageWebviewShortcuts({
  browserTabId,
  workspaceId,
  isActive,
  chromeShortcutScope,
  isActiveRef,
  webviewRef,
  paneZoomLevelRef,
  setBrowserDefaultZoomLevel,
  showBrowserZoomFeedback,
  reloadWebviewOrRecoverGuest
}: {
  browserTabId: string
  workspaceId: string
  isActive: boolean
  chromeShortcutScope: BrowserChromeShortcutScope
  isActiveRef: MutableRefObject<boolean>
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  paneZoomLevelRef: MutableRefObject<number>
  setBrowserDefaultZoomLevel: (level: number) => void
  showBrowserZoomFeedback: (level: number) => void
  reloadWebviewOrRecoverGuest: (ignoreCache: boolean) => void
}): void {
  const keybindings = useAppStore((state) => state.keybindings)

  // Browser history shortcuts (renderer path: focus on browser chrome)
  // Why: macOS can't deliver Logitech side-buttons to Electron; Logi Options+ remaps them to history chords, handled here when chrome is focused.
  useEffect(() => {
    if (chromeShortcutScope === 'inactive') {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      const direction = keybindingMatchesAction('browser.back', e, shortcutPlatform, keybindings)
        ? 'back'
        : keybindingMatchesAction('browser.forward', e, shortcutPlatform, keybindings)
          ? 'forward'
          : null
      if (
        direction === null ||
        !browserChromeShortcutOwnsEvent(chromeShortcutScope, e, workspaceId)
      ) {
        return
      }
      e.preventDefault()
      // Why: stop other window capture listeners (workspace, embedded editors) from also acting.
      e.stopImmediatePropagation()
      // Why: Logitech Options+ side-button remaps arrive as these chords on macOS; route through the same nav path as the toolbar.
      if (direction === 'back') {
        webviewRef.current?.goBack()
      } else {
        webviewRef.current?.goForward()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [chromeShortcutScope, keybindings, webviewRef, workspaceId])

  // Browser history shortcuts (IPC path: focus inside webview guest)
  // Why: a focused webview is a separate WebContents, so main forwards the chords back here.
  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onBrowserHistoryNavigate(({ browserPageId, direction }) => {
      if (browserPageId !== browserTabId) {
        return
      }
      // Why: Logitech Options+ side-button remaps arrive as these chords on macOS; route through the same nav path as the toolbar.
      if (direction === 'back') {
        webviewRef.current?.goBack()
      } else {
        webviewRef.current?.goForward()
      }
    })
  }, [browserTabId, isActive, webviewRef])

  // Cmd/Ctrl+R — reload (renderer path: focus on browser chrome, not in guest)
  // Why: guest shortcut forwarding never fires when focus is on browser chrome, so handle the chord directly here.
  useEffect(() => {
    if (chromeShortcutScope === 'inactive') {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      const isHardReload = keybindingMatchesAction(
        'browser.hardReload',
        e,
        shortcutPlatform,
        keybindings
      )
      const isReload = keybindingMatchesAction('browser.reload', e, shortcutPlatform, keybindings)
      if (!isHardReload && !isReload) {
        return
      }
      if (
        isEditableKeyboardTarget(e.target) ||
        !browserChromeShortcutOwnsEvent(chromeShortcutScope, e, workspaceId)
      ) {
        return
      }
      e.preventDefault()
      e.stopImmediatePropagation()
      reloadWebviewOrRecoverGuest(isHardReload)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [chromeShortcutScope, keybindings, reloadWebviewOrRecoverGuest, workspaceId])

  // Cmd/Ctrl+R — reload (IPC path: focus inside webview guest)
  // Why: a focused guest is a separate Chromium process, so main forwards the chord back here.
  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onReloadBrowserPage(({ browserPageId }) => {
      if (browserPageId === browserTabId) {
        reloadWebviewOrRecoverGuest(false)
      }
    })
  }, [browserTabId, isActive, reloadWebviewOrRecoverGuest])

  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onHardReloadBrowserPage(({ browserPageId }) => {
      if (browserPageId === browserTabId) {
        reloadWebviewOrRecoverGuest(true)
      }
    })
  }, [browserTabId, isActive, reloadWebviewOrRecoverGuest])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const applyActivePageZoom = (direction: BrowserPageZoomDirection): void => {
      if (!isActiveRef.current) {
        return
      }
      // Why: reset targets 100% like Chromium; the configured default is a new-tab seed, not a reset target.
      const nextLevel = applyBrowserPageZoom(webviewRef.current, direction)
      if (nextLevel !== null) {
        paneZoomLevelRef.current = nextLevel
        rememberExplicitBrowserPageZoomLevel(browserTabId, nextLevel)
        setBrowserDefaultZoomLevel(nextLevel)
        showBrowserZoomFeedback(nextLevel)
      }
    }
    const handleZoom = ({ browserPageId, direction }: BrowserPageZoomCommand): void => {
      if (browserPageId === browserTabId) {
        applyActivePageZoom(direction)
      }
    }
    const removeGuestListener = window.api.ui.onZoomBrowserPage(handleZoom)
    const removeLocalListener = addBrowserPageZoomEventListener(handleZoom)
    return () => {
      removeGuestListener()
      removeLocalListener()
    }
  }, [
    browserTabId,
    isActive,
    isActiveRef,
    paneZoomLevelRef,
    setBrowserDefaultZoomLevel,
    showBrowserZoomFeedback,
    webviewRef
  ])
}
