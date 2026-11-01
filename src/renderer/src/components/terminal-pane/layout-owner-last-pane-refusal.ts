import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { panesLeftAfterPendingCloses } from '@/runtime/layout-owner-pane-intents'

/** After main’s last-pane refusal, close the tab if pending closes leave one pane; otherwise close locally to handle lagging main state; leave unmounted tabs alone. */
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
