import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import { browserChromeShortcutOwnsEvent } from '../describe-page/browser-overlay-shortcut-target'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'

/** Cmd+Y (Ctrl+H on Linux/Windows) opens the history view, from the page or from Orca's chrome. */
export function useBrowserHistoryShortcut({
  browserTabId,
  workspaceId,
  isActive,
  chromeShortcutScope
}: {
  browserTabId: string
  workspaceId: string
  isActive: boolean
  chromeShortcutScope: BrowserChromeShortcutScope
}): void {
  const setBrowserHistoryPageId = useAppStore((s) => s.setBrowserHistoryPageId)
  const keybindings = useAppStore((s) => s.keybindings)

  useEffect(() => {
    if (!isActive) {
      return
    }
    // Why: a focused page swallows the chord in main, which forwards it here.
    const unsubscribe = window.api.ui.onShowBrowserHistory(({ browserPageId }) => {
      if (browserPageId === browserTabId) {
        setBrowserHistoryPageId(browserTabId)
      }
    })
    return () => {
      unsubscribe()
      // Why: a history view left over a page the user switched away from would open its pick there.
      if (useAppStore.getState().browserHistoryPageId === browserTabId) {
        setBrowserHistoryPageId(null)
      }
    }
  }, [browserTabId, isActive, setBrowserHistoryPageId])

  useEffect(() => {
    if (chromeShortcutScope === 'inactive') {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!keybindingMatchesAction('browser.showHistory', event, shortcutPlatform, keybindings)) {
        return
      }
      // Why: an open view keeps its page; its portaled search field sits outside every pane, so
      // ownership would hand the chord, and the next pick, to whichever pane claims stray keys.
      const historyOpen = useAppStore.getState().browserHistoryPageId !== null
      if (
        !historyOpen &&
        !browserChromeShortcutOwnsEvent(chromeShortcutScope, event, workspaceId)
      ) {
        return
      }
      event.preventDefault()
      // Why: every mounted pane registers this same capture listener on window.
      event.stopImmediatePropagation()
      if (!historyOpen) {
        setBrowserHistoryPageId(browserTabId)
      }
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [browserTabId, chromeShortcutScope, keybindings, setBrowserHistoryPageId, workspaceId])
}
