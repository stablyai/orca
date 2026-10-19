import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { panesLeftAfterPendingCloses } from '@/runtime/layout-owner-pane-intents'

/**
 * Main refused a pane close as its last pane. An earlier close in flight took the sibling: once
 * it lands here too, or is about to, the tab closes. More panes here than main has: main's copy
 * lags, so close as today. An unmounted tab is left alone.
 */
export function closeAfterLastPaneRefusal(
  tabId: string,
  manager: PaneManager | null,
  closeTab: () => void,
  closePaneAsToday: (paneId: number) => void,
  paneId: number
): void {
  if (!manager) {
    return
  }
  const panes = panesLeftAfterPendingCloses(
    tabId,
    manager.getPanes().map((pane) => pane.leafId)
  )
  if (panes <= 1) {
    closeTab()
  } else {
    closePaneAsToday(paneId)
  }
}
