import { useAppStore } from '@/store'
import { FOCUS_TERMINAL_PANE_EVENT, type FocusTerminalPaneDetail } from '@/constants/terminal'

export function activateTabAndFocusPane(
  tabId: string,
  leafId: string | null,
  opts?: {
    ackPaneKeyOnSuccess?: string
    flashFocusedPane?: boolean
    scrollToBottomIfOutputSinceLastView?: boolean
  }
): void {
  useAppStore.getState().setActiveTab(tabId)
  if (leafId === null) {
    return
  }
  // Why: defer one frame so the new TerminalPane has mounted its
  // FOCUS_TERMINAL_PANE_EVENT listener before we dispatch.
  requestAnimationFrame(() => {
    const detail: FocusTerminalPaneDetail = {
      tabId,
      leafId,
      ...(opts?.ackPaneKeyOnSuccess ? { ackPaneKeyOnSuccess: opts.ackPaneKeyOnSuccess } : {}),
      ...(opts?.flashFocusedPane ? { flashFocusedPane: true } : {}),
      ...(opts?.scrollToBottomIfOutputSinceLastView
        ? { scrollToBottomIfOutputSinceLastView: true }
        : {})
    }
    window.dispatchEvent(
      new CustomEvent<FocusTerminalPaneDetail>(FOCUS_TERMINAL_PANE_EVENT, {
        detail
      })
    )
  })
}
