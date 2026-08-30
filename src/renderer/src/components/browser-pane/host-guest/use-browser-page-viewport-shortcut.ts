import { useEffect } from 'react'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import { browserOverlayOwnsShortcutTarget } from '../describe-page/browser-overlay-shortcut-target'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import {
  applyBrowserPageViewportPreset,
  resolveBrowserViewportToggleTarget
} from './browser-viewport-preset-actions'

export function useBrowserPageViewportShortcut({
  browserPage,
  workspaceId,
  chromeShortcutScope
}: {
  browserPage: BrowserPage
  workspaceId: string
  chromeShortcutScope: BrowserChromeShortcutScope
}): void {
  const keybindings = useAppStore((state) => state.keybindings)

  useEffect(() => {
    if (chromeShortcutScope === 'inactive') {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        !keybindingMatchesAction(
          'browser.toggleMobileViewport',
          event,
          shortcutPlatform,
          keybindings
        ) ||
        (chromeShortcutScope === 'owned-target' &&
          !browserOverlayOwnsShortcutTarget(event.target, workspaceId))
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      applyBrowserPageViewportPreset(
        browserPage.id,
        resolveBrowserViewportToggleTarget(browserPage)
      )
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [browserPage, chromeShortcutScope, keybindings, workspaceId])

  useEffect(() => {
    return window.api.ui.onToggleBrowserViewport((browserPageId) => {
      if (browserPageId !== browserPage.id) {
        return
      }
      applyBrowserPageViewportPreset(
        browserPage.id,
        resolveBrowserViewportToggleTarget(browserPage)
      )
    })
  }, [browserPage])
}
