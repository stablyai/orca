import { useEffect, type MutableRefObject } from 'react'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import { browserChromeShortcutOwnsEvent } from '../describe-page/browser-overlay-shortcut-target'
import type { BrowserChromeShortcutScope, GrabIntent } from '../describe-page/browser-page-types'
import { isEditableKeyboardTarget } from './browser-keyboard'
import { useBrowserPageWebviewShortcuts } from './use-browser-page-webview-shortcuts'

export function useBrowserPageKeyboardShortcuts({
  browserTabId,
  workspaceId,
  isActive,
  chromeShortcutScope,
  isActiveRef,
  markupIsActive,
  webviewRef,
  paneZoomLevelRef,
  showBrowserZoomFeedback,
  reloadWebviewOrRecoverGuest,
  startGrabIntent,
  handleGrabActionShortcut,
  grabIsInteractive
}: {
  browserTabId: string
  workspaceId: string
  isActive: boolean
  chromeShortcutScope: BrowserChromeShortcutScope
  isActiveRef: MutableRefObject<boolean>
  markupIsActive: boolean
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  paneZoomLevelRef: MutableRefObject<number>
  showBrowserZoomFeedback: (level: number) => void
  reloadWebviewOrRecoverGuest: (ignoreCache: boolean) => void
  startGrabIntent: (intent: GrabIntent) => void
  handleGrabActionShortcut: (key: 'c' | 's') => void
  grabIsInteractive: boolean
}): void {
  const keybindings = useAppStore((state) => state.keybindings)

  useBrowserPageWebviewShortcuts({
    browserTabId,
    workspaceId,
    isActive,
    chromeShortcutScope,
    isActiveRef,
    webviewRef,
    paneZoomLevelRef,
    showBrowserZoomFeedback,
    reloadWebviewOrRecoverGuest
  })

  // Why: Cmd+C is repurposed as the grab-mode gesture; native text copy in the guest is handled by Chromium and never reaches here.
  useEffect(() => {
    if (chromeShortcutScope === 'inactive') {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Why: don't intercept in editable targets so native Cmd+C still copies in inputs/contentEditable.
      if (isEditableKeyboardTarget(e.target)) {
        return
      }
      const intent: GrabIntent | null = keybindingMatchesAction(
        'browser.grabElement',
        e,
        shortcutPlatform,
        keybindings
      )
        ? 'copy'
        : keybindingMatchesAction('browser.annotateElement', e, shortcutPlatform, keybindings)
          ? 'annotate'
          : null
      if (
        intent === null ||
        // Why: startGrabIntent toggles, so a held chord would flicker the picker on and off.
        e.repeat ||
        // Why: don't start the in-guest picker behind an open markup overlay (matches the disabled toolbar buttons).
        markupIsActive ||
        !browserChromeShortcutOwnsEvent(chromeShortcutScope, e, workspaceId) ||
        // Why: a live selection means copy; selecting in the floating panel or a sidebar keeps scope.
        (intent === 'copy' && window.getSelection()?.isCollapsed === false)
      ) {
        return
      }
      e.preventDefault()
      startGrabIntent(intent)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [chromeShortcutScope, keybindings, markupIsActive, startGrabIntent, workspaceId])

  // Why: a focused guest keeps its key events; main forwards the grab/annotate chords back with their intent.
  useEffect(() => {
    return window.api.browser.onGrabModeToggle((tabId, intent) => {
      // Why: a guest can hold keyboard focus under the markup overlay, whose toolbar disables both tools.
      if (tabId === browserTabId && !markupIsActive) {
        startGrabIntent(intent)
      }
    })
  }, [browserTabId, markupIsActive, startGrabIntent])

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
