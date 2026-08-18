import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import { browserOverlayOwnsShortcutTarget } from '../describe-page/browser-overlay-shortcut-target'
import type { BrowserFindShortcutScope } from '../describe-page/browser-page-types'

export function useBrowserPageFindShortcuts({
  browserTabId,
  workspaceId,
  isActive,
  findShortcutScope,
  setFindOpen
}: {
  browserTabId: string
  workspaceId: string
  isActive: boolean
  findShortcutScope: BrowserFindShortcutScope
  setFindOpen: Dispatch<SetStateAction<boolean>>
}): void {
  const keybindings = useAppStore((state) => state.keybindings)

  // Cmd/Ctrl+F — find in page (renderer path: focus on browser chrome)
  // Why: unlike bare C/S grab shortcuts, Cmd+F should always open find even from the address bar (matches Chrome/Safari).
  useEffect(() => {
    if (findShortcutScope === 'inactive') {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!keybindingMatchesAction('browser.find', e, shortcutPlatform, keybindings)) {
        return
      }
      if (
        findShortcutScope === 'owned-target' &&
        !browserOverlayOwnsShortcutTarget(e.target, workspaceId)
      ) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      setFindOpen(true)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [findShortcutScope, keybindings, setFindOpen, workspaceId])

  // Cmd/Ctrl+F — find in page (IPC path: focus inside webview guest)
  // Why: a focused guest is a separate Chromium process, so main forwards the chord back here.
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

  // Close find bar when tab is deactivated
  useEffect(() => {
    if (!isActive) {
      setFindOpen(false)
    }
  }, [isActive, setFindOpen])
}
