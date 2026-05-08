import { useAppStore } from '@/store'
import { FOCUS_TERMINAL_PANE_EVENT, type FocusTerminalPaneDetail } from '@/constants/terminal'

export function activateTabAndFocusPane(tabId: string, paneId: number | null): void {
  useAppStore.getState().setActiveTab(tabId)
  if (paneId === null) {
    return
  }
  // Why: defer one frame so the new TerminalPane has mounted its
  // FOCUS_TERMINAL_PANE_EVENT listener before we dispatch.
  requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent<FocusTerminalPaneDetail>(FOCUS_TERMINAL_PANE_EVENT, {
        detail: { tabId, paneId }
      })
    )
  })
}
