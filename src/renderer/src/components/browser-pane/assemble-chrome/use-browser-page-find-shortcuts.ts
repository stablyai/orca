import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import { browserChromeShortcutOwnsEvent } from '../describe-page/browser-overlay-shortcut-target'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

export function useBrowserPageFindShortcuts({
  browserTabId,
  workspaceId,
  isActive,
  chromeShortcutScope,
  setFindOpen
}: {
  browserTabId: string
  workspaceId: string
  isActive: boolean
  chromeShortcutScope: BrowserChromeShortcutScope
  setFindOpen: Dispatch<SetStateAction<boolean>>
}): void {
  const keybindings = useAppStore((state) => state.keybindings)

  // Allow Cmd/Ctrl+F from chrome, including the address bar, unlike bare grab shortcuts.
  useEffect(() => {
    if (chromeShortcutScope === 'inactive') {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!keybindingMatchesAction('browser.find', e, shortcutPlatform, keybindings)) {
        return
      }
      if (!browserChromeShortcutOwnsEvent(chromeShortcutScope, e, workspaceId)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      setFindOpen(true)
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [chromeShortcutScope, keybindings, setFindOpen, workspaceId])

  // Main forwards chords from the separately focused guest back to this pane.
  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onFindInBrowserPage(
      { browserPageId: browserTabId, browserWorkspaceId: workspaceId },
      () => {
        setFindOpen(true)
      }
    )
  }, [browserTabId, isActive, setFindOpen, workspaceId])

  useEffect(() => {
    if (!isActive) {
      setFindOpen(false)
    }
  }, [isActive, setFindOpen])
}
