import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'

/**
 * Routes the app window to a pane the user clicked in the notch panel.
 *
 * Why its own bridge rather than the dashboard's: the pop-out relay is gated behind the
 * experimental dashboard setting, and the notch must work without it. Main raises (or reopens)
 * the window before sending, so this only has to navigate.
 */
export function useNotchRevealBridge(): void {
  useEffect(() => {
    const unsubscribe = window.api.notch?.onRevealPane?.((args) => {
      useAppStore.getState().setActiveWorktree(args.worktreeId)
      activateTabAndFocusPane(args.tabId, args.leafId, { flashFocusedPane: true })
    })
    // Why: main buffers a reveal until this ack. did-finish-load fires before React commits
    // this effect, and ipcRenderer does not queue, so without the handshake a row click with
    // the app window closed was silently dropped every time.
    window.api.notch?.notifyRevealReady?.()
    return unsubscribe
  }, [])
}
