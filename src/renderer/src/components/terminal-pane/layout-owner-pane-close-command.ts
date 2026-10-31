import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { layoutFramesFlowing } from '@/runtime/layout-frame-position'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { expectPaneToClose } from '@/runtime/layout-owner-pane-intents'
import { closeAfterLastPaneRefusal } from './layout-owner-last-pane-refusal'

/** Main closes first and its frame removes the pane; false delegates paired-server ownership to the caller. */
function sendPaneCloseToLayoutOwner(
  pane: { worktreeId: string; tabId: string; leafId: string },
  on: {
    /** Main cannot close it: close as today. */
    asToday: () => void
    /** Main refused the pane as its last. */
    lastPane: () => void
    /** Close locally if main already removed the pane or no frame stream can deliver its removal. */
    closeHere: () => void
  }
): boolean {
  const { tabId, leafId } = pane
  const forget = expectPaneToClose(tabId, leafId, 'user')
  const sent = sendLayoutCommandToOwner(
    pane.worktreeId,
    { type: 'closePane', tabId, leafId },
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
    { worktreeId: pane.worktreeId, tabId, leafId },
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
