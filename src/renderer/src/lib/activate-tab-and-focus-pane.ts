import { useAppStore } from '@/store'
import { FOCUS_TERMINAL_PANE_EVENT, type FocusTerminalPaneDetail } from '@/constants/terminal'
import {
  scheduleAfterAnimationFrameOrTimeout,
  type ScheduledAnimationFrameFallback
} from './schedule-after-animation-frame-or-timeout'

let pendingFocusPaneFrame: ScheduledAnimationFrameFallback | null = null

function cancelPendingFocusPaneFrame(): void {
  pendingFocusPaneFrame?.cancel()
  pendingFocusPaneFrame = null
}

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
  cancelPendingFocusPaneFrame()
  if (leafId === null) {
    return
  }
  // Why: defer one frame so the new TerminalPane has mounted its listener.
  // Hidden/headless Electron windows can pause rAF, so the timeout keeps focus usable.
  pendingFocusPaneFrame = scheduleAfterAnimationFrameOrTimeout(() => {
    pendingFocusPaneFrame = null
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
