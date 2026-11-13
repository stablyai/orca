import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import { browserChromeShortcutOwnsEvent } from '../describe-page/browser-overlay-shortcut-target'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'

/** The focus-address-bar chord while Orca's chrome has the keyboard. */
export function useBrowserAddressBarShortcut({
  workspaceId,
  chromeShortcutScope,
  focusAddressBarNow
}: {
  workspaceId: string
  chromeShortcutScope: BrowserChromeShortcutScope
  focusAddressBarNow: () => boolean
}): void {
  const keybindings = useAppStore((s) => s.keybindings)

  // Guest-focused chords arrive through IPC; capture handles chrome-focused chords before workspace/editor listeners.
  useEffect(() => {
    if (chromeShortcutScope === 'inactive') {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        !keybindingMatchesAction('browser.focusAddressBar', event, shortcutPlatform, keybindings)
      ) {
        return
      }
      if (!browserChromeShortcutOwnsEvent(chromeShortcutScope, event, workspaceId)) {
        return
      }
      event.preventDefault()
      // All panes listen on window capture; stopPropagation alone leaves sibling listeners active.
      event.stopImmediatePropagation()
      focusAddressBarNow()
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [chromeShortcutScope, focusAddressBarNow, keybindings, workspaceId])
}
