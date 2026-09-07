import { useEffect, type MutableRefObject } from 'react'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import { isEditableKeyboardTarget } from './browser-keyboard'
import {
  addBrowserPageZoomEventListener,
  applyBrowserPageZoom,
  rememberExplicitBrowserPageZoomLevel,
  type BrowserPageZoomDirection
} from './browser-page-zoom'

/**
 * History, reload and zoom chords for a <webview>-backed pane — local and client-hosted alike.
 * Each one is handled twice: once for chrome focus, where the chord never leaves the renderer,
 * and once for the IPC main forwards when the guest (its own Chromium process) holds focus.
 */
export function useBrowserPageWebviewShortcuts({
  browserTabId,
  isActive,
  isActiveRef,
  webviewRef,
  paneZoomLevelRef,
  setBrowserDefaultZoomLevel,
  showBrowserZoomFeedback,
  reloadWebviewOrRecoverGuest
}: {
  browserTabId: string
  isActive: boolean
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
    if (!isActive) {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      const direction = keybindingMatchesAction('browser.back', e, shortcutPlatform, keybindings)
        ? 'back'
        : keybindingMatchesAction('browser.forward', e, shortcutPlatform, keybindings)
          ? 'forward'
          : null
      if (direction === null) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      // Why: Logitech Options+ side-button remaps arrive as these chords on macOS; route through the same nav path as the toolbar.
      if (direction === 'back') {
        webviewRef.current?.goBack()
      } else {
        webviewRef.current?.goForward()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isActive, keybindings, webviewRef])

  // Browser history shortcuts (IPC path: focus inside webview guest)
  // Why: a focused webview is a separate WebContents, so main forwards the chords back here.
  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onBrowserHistoryNavigate((direction) => {
      // Why: Logitech Options+ side-button remaps arrive as these chords on macOS; route through the same nav path as the toolbar.
      if (direction === 'back') {
        webviewRef.current?.goBack()
      } else {
        webviewRef.current?.goForward()
      }
    })
  }, [isActive, webviewRef])

  // Cmd/Ctrl+R — reload (renderer path: focus on browser chrome, not in guest)
  // Why: guest shortcut forwarding never fires when focus is on browser chrome, so handle the chord directly here.
  useEffect(() => {
    if (!isActive) {
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
      if (isEditableKeyboardTarget(e.target)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      reloadWebviewOrRecoverGuest(isHardReload)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isActive, keybindings, reloadWebviewOrRecoverGuest])

  // Cmd/Ctrl+R — reload (IPC path: focus inside webview guest)
  // Why: a focused guest is a separate Chromium process, so main forwards the chord back here.
  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onReloadBrowserPage(() => {
      reloadWebviewOrRecoverGuest(false)
    })
  }, [isActive, reloadWebviewOrRecoverGuest])

  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onHardReloadBrowserPage(() => {
      reloadWebviewOrRecoverGuest(true)
    })
  }, [isActive, reloadWebviewOrRecoverGuest])

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
    const removeGuestListener = window.api.ui.onZoomBrowserPage(applyActivePageZoom)
    const removeLocalListener = addBrowserPageZoomEventListener((detail) => {
      if (detail.browserPageId !== browserTabId) {
        return
      }
      applyActivePageZoom(detail.direction)
    })
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
