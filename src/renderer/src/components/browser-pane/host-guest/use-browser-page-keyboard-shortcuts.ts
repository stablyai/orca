import { useEffect, type MutableRefObject } from 'react'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import { isEditableKeyboardTarget } from './browser-keyboard'
import { useBrowserPageWebviewShortcuts } from './use-browser-page-webview-shortcuts'
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
  handleGrabActionShortcut: (key: 'c' | 's') => void
  grabIsInteractive: boolean
}): void {
  const keybindings = useAppStore((state) => state.keybindings)

  useBrowserPageWebviewShortcuts({
    browserTabId,
    isActive,
    isActiveRef,
    webviewRef,
    paneZoomLevelRef,
    setBrowserDefaultZoomLevel,
    showBrowserZoomFeedback,
    reloadWebviewOrRecoverGuest
  })

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
