import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { captureTerminalTabForWindowDetach } from './terminal-tab-window-detach'

/**
 * Returns a callback that detaches one or more terminal tabs into one OS
 * window. The seed rides along in the detach IPC call, so `closeTab` only runs
 * once the OS window exists with its seed stored main-side — a failed detach
 * leaves every selected tab in place instead of vanishing with no way back.
 */
export function useDetachTerminalTabToWindow(worktreeId: string) {
  const closeTab = useAppStore((s) => s.closeTab)

  return useCallback(
    (tabId: string, additionalTabIds?: string[]) => {
      const state = useAppStore.getState()
      const seed = captureTerminalTabForWindowDetach(state, worktreeId, tabId, additionalTabIds)
      if (!seed) {
        console.error('[detach-to-window] could not build a detach seed for tab', tabId)
        toast.error(translate('detachToWindow.error', 'Could not detach tab to a new window'))
        return
      }
      void window.api.pane
        .detach(tabId, seed)
        .then(() => {
          for (const detachedTabId of [tabId, ...(additionalTabIds ?? [])]) {
            closeTab(detachedTabId, {
              localPtyTeardownOwnedExternally: true,
              captureRecentlyClosed: false
            })
          }
        })
        .catch((error) => {
          console.error('[detach-to-window] failed to detach tab to a new window', error)
          toast.error(translate('detachToWindow.error', 'Could not detach tab to a new window'))
        })
    },
    [closeTab, worktreeId]
  )
}
