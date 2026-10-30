import { useEffect } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../shared/keybindings'

/** The pop-out has no Window menu or tab routing, so its close-tab chord closes the window. */
export function useDashboardPopoutCloseShortcut(): void {
  useEffect(() => {
    const platform = getShortcutPlatform()
    const onKeyDown = (event: KeyboardEvent): void => {
      // The terminal preview dialog owns this chord: it closes the dialog or reaches the shell.
      if (
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest('[role="dialog"]'))
      ) {
        return
      }
      if (
        keybindingMatchesAction('tab.close', event, platform, useAppStore.getState().keybindings)
      ) {
        event.preventDefault()
        window.close()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
