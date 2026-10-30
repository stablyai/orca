import { useEffect, type MutableRefObject } from 'react'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import { browserChromeShortcutOwnsEvent } from '../describe-page/browser-overlay-shortcut-target'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { isEditableKeyboardTarget } from './browser-keyboard'
import { addBrowserPageZoomEventListener, type BrowserPageZoomCommand } from './browser-page-zoom'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

/** Handle chrome chords in the renderer and guest chords through main’s IPC; focused guests own a separate WebContents. */
export function useBrowserPageWebviewShortcuts({
  browserTabId,
  workspaceId,
  isActive,
  chromeShortcutScope,
  isActiveRef,
  webviewRef,
  showBrowserZoomFeedback,
  reloadWebviewOrRecoverGuest
}: {
  browserTabId: string
  workspaceId: string
  isActive: boolean
  chromeShortcutScope: BrowserChromeShortcutScope
  isActiveRef: MutableRefObject<boolean>
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  showBrowserZoomFeedback: (level: number) => void
  reloadWebviewOrRecoverGuest: (ignoreCache: boolean) => void
}): void {
  const keybindings = useAppStore((state) => state.keybindings)

  // Logi Options+ remaps macOS side-buttons to history chords that chrome must handle here.
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
      if (direction === 'back') {
        webviewRef.current?.goBack()
      } else {
        webviewRef.current?.goForward()
      }
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [chromeShortcutScope, keybindings, webviewRef, workspaceId])

  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onBrowserHistoryNavigate(({ browserPageId, direction }) => {
      if (browserPageId !== browserTabId) {
        return
      }
      if (direction === 'back') {
        webviewRef.current?.goBack()
      } else {
        webviewRef.current?.goForward()
      }
    })
  }, [browserTabId, isActive, webviewRef])

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
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [chromeShortcutScope, keybindings, reloadWebviewOrRecoverGuest, workspaceId])

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
    // Why main: zoom belongs to the page's site in its browser profile, which main remembers.
    const handleZoom = ({ browserPageId, direction }: BrowserPageZoomCommand): void => {
      if (browserPageId !== browserTabId || !isActiveRef.current) {
        return
      }
      void window.api.browser.zoomPage({ browserPageId, direction }).then((display) => {
        if (display?.site) {
          showBrowserZoomFeedback(display.zoomLevel)
        }
      })
    }
    const removeGuestListener = window.api.ui.onZoomBrowserPage(handleZoom)
    const removeLocalListener = addBrowserPageZoomEventListener(handleZoom)
    return () => {
      removeGuestListener()
      removeLocalListener()
    }
  }, [browserTabId, isActive, isActiveRef, showBrowserZoomFeedback])
}
