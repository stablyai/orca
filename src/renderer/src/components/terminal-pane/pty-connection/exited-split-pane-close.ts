import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { panesLeftAfterPendingCloses } from '@/runtime/layout-owner-pane-intents'
import { sendPaneCloseToLayoutOwner } from '../layout-owner-pane-close-command'

/**
 * A split pane whose terminal ended, in a layout-owner build: main closes it first, then the
 * window removes it when main's frame does. False when a paired server owns the workspace; the
 * caller closes as today.
 */
export function closeExitedSplitPaneThroughLayoutOwner(args: {
  worktreeId: string
  tabId: string
  manager: PaneManager
  paneId: number
  /** The tab-level exit, for a pane that became the tab's last while main answered. */
  closeTab: () => void
}): boolean {
  const { manager, paneId } = args
  const leafId = manager.getLeafId(paneId)
  if (!leafId) {
    return false
  }
  const close = (): void => {
    // Why the leaf check: main's answer can land after the pane already went.
    if (manager.getLeafId(paneId) !== leafId) {
      return
    }
    // A sibling went, or is going, while main answered: this pane is now the tab's last.
    if (
      panesLeftAfterPendingCloses(
        args.tabId,
        manager.getPanes().map((pane) => pane.leafId)
      ) <= 1
    ) {
      args.closeTab()
      return
    }
    manager.closePane(paneId)
  }
  // Main holds this pane alone while the window has more: its copy lags, so close as today.
  return sendPaneCloseToLayoutOwner(
    { worktreeId: args.worktreeId, tabId: args.tabId, leafId, kind: 'exit' },
    { asToday: close, lastPane: close, closeHere: close }
  )
}
