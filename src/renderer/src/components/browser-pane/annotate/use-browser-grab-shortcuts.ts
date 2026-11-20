import { useEffect } from 'react'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../../shared/keybindings/matching'
import { browserChromeShortcutOwnsEvent } from '../describe-page/browser-overlay-shortcut-target'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import type { GrabIntent } from '../../../../../shared/browser/element-grab/browser-grab-types'
import { isEditableKeyboardTarget } from '../host-guest/input/browser-keyboard'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import type { BrowserGuestToolsTransport } from './browser-guest-tools-transport'

/** The grab/annotate chords and the C/S picks, for any surface that hosts the element picker. */
export function useBrowserGrabShortcuts({
  enabled = true,
  transport,
  browserTabId,
  workspaceId,
  chromeShortcutScope,
  markupIsActive,
  toolsDisabled = false,
  startGrabIntent,
  handleGrabActionShortcut,
  grabIsInteractive
}: {
  enabled?: boolean
  transport: Pick<BrowserGuestToolsTransport, 'onGrabModeToggle' | 'onGrabActionShortcut'>
  browserTabId: string
  workspaceId: string
  chromeShortcutScope: BrowserChromeShortcutScope
  markupIsActive: boolean
  toolsDisabled?: boolean
  startGrabIntent: (intent: GrabIntent) => void
  handleGrabActionShortcut: (key: 'c' | 's') => void
  grabIsInteractive: boolean
}): void {
  const keybindings = useAppStore((state) => state.keybindings)

  // Why: Cmd+C is repurposed as the grab-mode gesture; native text copy in the guest is handled by Chromium and never reaches here.
  useEffect(() => {
    if (!enabled || chromeShortcutScope === 'inactive') {
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
        // A pane already acted on the key, e.g. a streamed page forwarding Cmd+C as a remote copy.
        e.defaultPrevented ||
        // Why: startGrabIntent toggles, so a held chord would flicker the picker on and off.
        e.repeat ||
        // Why: don't start the in-guest picker behind an open markup overlay (matches the disabled toolbar buttons).
        markupIsActive ||
        (toolsDisabled && !grabIsInteractive) ||
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
  }, [
    chromeShortcutScope,
    enabled,
    grabIsInteractive,
    keybindings,
    markupIsActive,
    startGrabIntent,
    toolsDisabled,
    workspaceId
  ])

  // Why: a focused guest keeps its key events; main forwards the grab/annotate chords back with their intent.
  useEffect(() => {
    if (!enabled) {
      return
    }
    return transport.onGrabModeToggle((tabId, intent) => {
      // Why: a guest can hold keyboard focus under the markup overlay, whose toolbar disables both tools.
      if (tabId === browserTabId && !markupIsActive && (!toolsDisabled || grabIsInteractive)) {
        startGrabIntent(intent)
      }
    })
  }, [
    browserTabId,
    enabled,
    grabIsInteractive,
    markupIsActive,
    startGrabIntent,
    toolsDisabled,
    transport
  ])

  useEffect(() => {
    if (!enabled || !grabIsInteractive) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (isEditableKeyboardTarget(e.target)) {
        return
      }
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
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [enabled, grabIsInteractive, handleGrabActionShortcut])

  useEffect(() => {
    if (!enabled || !grabIsInteractive) {
      return
    }
    return transport.onGrabActionShortcut(({ browserPageId, key }) => {
      if (browserPageId !== browserTabId) {
        return
      }
      handleGrabActionShortcut(key)
    })
  }, [browserTabId, enabled, grabIsInteractive, handleGrabActionShortcut, transport])
}
