import { useEffect, type MutableRefObject } from 'react'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { useAppStore } from '@/store/index'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import { browserChromeShortcutOwnsEvent } from '../../describe-page/browser-overlay-shortcut-target'
import type { BrowserChromeShortcutScope } from '../../describe-page/browser-page-types'
import {
  browserGuestToolKeyFromEvent,
  isBrowserGrabActionKey,
  isBrowserGuestToolKey,
  type BrowserAnnotateToolKey,
  type BrowserGrabActionKey,
  type GrabIntent
} from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { isEditableKeyboardTarget } from './browser-keyboard'
import { annotateLetterOwner } from '../../annotate/palette/annotate-esc-ownership'
import { useBrowserPageWebviewShortcuts } from './use-browser-page-webview-shortcuts'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'

/** Bare tool letters act only from this page's own surfaces, or from no element when this page was used last. */
function annotateKeysOwnTarget(target: EventTarget | null, browserTabId: string): boolean {
  return annotateLetterOwner(target) === browserTabId
}

export function useBrowserPageKeyboardShortcuts({
  browserTabId,
  workspaceId,
  isActive,
  chromeShortcutScope,
  isActiveRef,
  markupIsActive,
  webviewRef,
  showBrowserZoomFeedback,
  reloadWebviewOrRecoverGuest,
  startGrabIntent,
  handleGrabActionShortcut,
  handleAnnotateToolKey,
  grabIsInteractive,
  annotateToolOn = false
}: {
  browserTabId: string
  workspaceId: string
  isActive: boolean
  chromeShortcutScope: BrowserChromeShortcutScope
  isActiveRef: MutableRefObject<boolean>
  markupIsActive: boolean
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  showBrowserZoomFeedback: (level: number) => void
  reloadWebviewOrRecoverGuest: (ignoreCache: boolean) => void
  startGrabIntent: (intent: GrabIntent) => void
  handleGrabActionShortcut: (key: BrowserGrabActionKey) => void
  /** A/G/D switch the annotate palette's tool while picking or drawing. */
  handleAnnotateToolKey: (key: BrowserAnnotateToolKey) => void
  grabIsInteractive: boolean
  /** Any annotate tool is on, including Draw while it waits for the picker's teardown. */
  annotateToolOn?: boolean
}): void {
  const keybindings = useAppStore((state) => state.keybindings)

  useBrowserPageWebviewShortcuts({
    browserTabId,
    workspaceId,
    isActive,
    chromeShortcutScope,
    isActiveRef,
    webviewRef,
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

  const annotateModeIsOn = grabIsInteractive || markupIsActive || annotateToolOn
  useEffect(() => {
    if (!annotateModeIsOn || !isActive) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      // keyCode 229 marks IME composition on engines that don't set isComposing.
      if (
        isEditableKeyboardTarget(e.target) ||
        e.isComposing ||
        e.keyCode === 229 ||
        !annotateKeysOwnTarget(e.target, browserTabId)
      ) {
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.getModifierState?.('AltGraph')) {
        return
      }
      const key = browserGuestToolKeyFromEvent(e)
      if (!isBrowserGuestToolKey(key)) {
        return
      }
      if (isBrowserGrabActionKey(key)) {
        // Why: copy and screenshot only mean something while the picker runs, not while drawing.
        if (!grabIsInteractive) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        handleGrabActionShortcut(key)
        return
      }
      // Why: a held key would flip tools on every repeat.
      if (e.repeat) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      handleAnnotateToolKey(key)
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [
    annotateModeIsOn,
    browserTabId,
    grabIsInteractive,
    handleAnnotateToolKey,
    handleGrabActionShortcut,
    isActive
  ])

  useEffect(() => {
    if (!grabIsInteractive) {
      return
    }
    return window.api.browser.onGrabActionShortcut(({ browserPageId, key }) => {
      if (browserPageId !== browserTabId) {
        return
      }
      // Alt edges belong to the palette's see-through, which listens for them itself.
      if (key === 'alt-down' || key === 'alt-up') {
        return
      }
      if (isBrowserGrabActionKey(key)) {
        handleGrabActionShortcut(key)
      } else {
        handleAnnotateToolKey(key)
      }
    })
  }, [browserTabId, grabIsInteractive, handleAnnotateToolKey, handleGrabActionShortcut])
}
