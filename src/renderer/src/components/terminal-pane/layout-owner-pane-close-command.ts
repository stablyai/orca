import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { layoutFramesFlowing } from '@/runtime/layout-frame-position'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { expectPaneToClose, type PaneCloseKind } from '@/runtime/layout-owner-pane-intents'
import { closeAfterLastPaneRefusal } from './layout-owner-last-pane-refusal'

/**
 * A pane close in a layout-owner build: main closes the pane first, and the window removes it when
 * main's frame drops it (the frame reconciler runs the close `kind` names). False when a paired
 * server owns the workspace; the caller closes as today.
 */
export function sendPaneCloseToLayoutOwner(
  pane: { worktreeId: string; tabId: string; leafId: string; kind: PaneCloseKind },
  on: {
    /** Main cannot close it: close as today. */
    asToday: () => void
    /** Main refused the pane as its last. */
    lastPane: () => void
    /** Main closed it but no frame is coming (the stream is down, or main held no such pane):
     *  close it here. */
    closeHere: () => void
  }
): boolean {
  const { tabId, leafId } = pane
  const forget = expectPaneToClose(tabId, leafId, pane.kind)
  const sent = sendLayoutCommandToOwner(
    pane.worktreeId,
    { type: 'closePane', tabId, leafId, ...(pane.kind === 'exit' && { automatic: true }) },
    {
      apply: (result) => {
        // Already gone from main's copy (a workspace it lacks): no frame will drop it.
        if (result.alreadyClosed || !layoutFramesFlowing()) {
          forget()
          on.closeHere()
        }
      },
      asToday: () => {
        forget()
        on.asToday()
      },
      refused: (code) => {
        forget()
        if (code === 'last_pane') {
          on.lastPane()
        }
      }
    }
  )
  if (!sent) {
    forget()
  }
  return sent
}

/** The user's close of a pane, through main. */
export function sendUserPaneCloseToLayoutOwner(
  pane: { worktreeId: string; tabId: string; leafId: string; paneId: number },
  tab: {
    getManager: () => PaneManager | null
    closeTab: () => void
    closePaneLocally: (paneId: number, committedLeafId?: string) => void
  }
): boolean {
  const { tabId, leafId, paneId } = pane
  return sendPaneCloseToLayoutOwner(
    { worktreeId: pane.worktreeId, tabId, leafId, kind: 'user' },
    {
      asToday: () => tab.closePaneLocally(paneId),
      lastPane: () =>
        closeAfterLastPaneRefusal(
          tabId,
          tab.getManager(),
          tab.closeTab,
          tab.closePaneLocally,
          paneId
        ),
      closeHere: () => tab.closePaneLocally(paneId, leafId)
    }
  )
}
