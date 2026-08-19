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
import type { GrabIntent } from '../describe-page/browser-page-types'

export function useBrowserPageKeyboardShortcuts({
  browserTabId,
  isActive,
  isActiveRef,
  markupIsActive,
  webviewRef,
  paneZoomLevelRef,
  setBrowserDefaultZoomLevel,
  showBrowserZoomFeedback,
  reloadWebviewOrRecoverGuest,
  startGrabIntent,
  focusAddressBarNow,
  handleGrabActionShortcut,
  grabIsInteractive
}: {
  browserTabId: string
  isActive: boolean
  isActiveRef: MutableRefObject<boolean>
  markupIsActive: boolean
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  paneZoomLevelRef: MutableRefObject<number>
  setBrowserDefaultZoomLevel: (level: number) => void
  showBrowserZoomFeedback: (level: number) => void
  reloadWebviewOrRecoverGuest: (ignoreCache: boolean) => void
  startGrabIntent: (intent: GrabIntent) => void
  focusAddressBarNow: () => boolean
  handleGrabActionShortcut: (key: 'c' | 's') => void
  grabIsInteractive: boolean
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

  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onHardReloadBrowserPage(() => {
      reloadWebviewOrRecoverGuest(true)
    })
  }, [isActive, reloadWebviewOrRecoverGuest])

  // Why: Cmd+C is repurposed as the grab-mode gesture; native text copy in the guest is handled by Chromium and never reaches here.
  useEffect(() => {
    // Why: gate on isActive so only the active pane's global keydown listener toggles grab mode.
    if (!isActive) {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Why: don't intercept in editable targets so native Cmd+C still copies in inputs/contentEditable.
      if (isEditableKeyboardTarget(e.target)) {
        return
      }
      // Why: don't start the in-guest picker behind an open markup overlay (matches the disabled toolbar buttons).
      if (
        !markupIsActive &&
        keybindingMatchesAction('browser.grabElement', e, shortcutPlatform, keybindings)
      ) {
        e.preventDefault()
        startGrabIntent('copy')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isActive, keybindings, markupIsActive, startGrabIntent])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!keybindingMatchesAction('browser.focusAddressBar', e, shortcutPlatform, keybindings)) {
        return
      }
      // Why: capture Cmd/Ctrl+L before the workspace or an embedded editor can claim the same chord.
      e.preventDefault()
      e.stopPropagation()
      focusAddressBarNow()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [focusAddressBarNow, isActive, keybindings])

  // Why: a focused guest gets Cmd/Ctrl+C inside Chromium; main forwards it back only when the page wouldn't use it for native copy.
  useEffect(() => {
    return window.api.browser.onGrabModeToggle((tabId) => {
      if (tabId === browserTabId) {
        startGrabIntent('copy')
      }
    })
  }, [browserTabId, startGrabIntent])

  useEffect(() => {
    if (!grabIsInteractive) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (isEditableKeyboardTarget(e.target)) {
        return
      }
      // Ignore if modifier keys are held — user may be doing Cmd+C etc.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return
      }
      const key = e.key.toLowerCase()
      if (key !== 'c' && key !== 's') {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      handleGrabActionShortcut(key as 'c' | 's')
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [grabIsInteractive, handleGrabActionShortcut])

  useEffect(() => {
    if (!grabIsInteractive) {
      return
    }
    return window.api.browser.onGrabActionShortcut(({ browserPageId, key }) => {
      if (browserPageId !== browserTabId) {
        return
      }
      handleGrabActionShortcut(key)
    })
  }, [browserTabId, grabIsInteractive, handleGrabActionShortcut])
}
