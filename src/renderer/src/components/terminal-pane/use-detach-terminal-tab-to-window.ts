import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { captureTerminalTabForWindowDetach } from './terminal-tab-window-detach'

/**
 * Returns a callback that detaches a terminal tab into its own OS window.
 * The seed rides along in the detach IPC call, so `closeTab` only runs once
 * the OS window exists with its seed stored main-side — a failed detach
 * leaves the tab in place instead of vanishing with no way back.
 */
export function useDetachTerminalTabToWindow(worktreeId: string) {
  const closeTab = useAppStore((s) => s.closeTab)

  return useCallback(
    (tabId: string) => {
      const state = useAppStore.getState()
      const seed = captureTerminalTabForWindowDetach(state, worktreeId, tabId)
      if (!seed) {
        return
      }
      void window.api.pane
        .detach(tabId, seed)
        .then(() => {
          closeTab(tabId, { localPtyTeardownOwnedExternally: true, captureRecentlyClosed: false })
        })
        .catch((error) => {
          console.error('[detach-to-window] failed to detach tab to a new window', error)
          toast.error(translate('detachToWindow.error', 'Could not detach tab to a new window'))
        })
    },
    [closeTab, worktreeId]
  )
}
