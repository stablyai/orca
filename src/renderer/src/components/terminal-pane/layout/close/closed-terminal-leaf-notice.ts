import { captureTerminalPaneNoticeRetirement } from '../../mounting/terminal-pane-notice-retirement'
import { CLOSE_TERMINAL_PANE_EVENT, type CloseTerminalPaneDetail } from '@/constants/terminal'
import { collapseParkedTerminalLeaf } from '../../parking/output-watchers/terminal-parked-pty-watcher'
import {
  capturedPanesByTabId,
  isTerminalTabParked
} from '../../parking/output-watchers/terminal-parked-watcher-registry'
import type { TerminalTabCloseIntent } from '../../../terminal/terminal-tab-close-intent'

/** Remove main-closed leaves idempotently so this notice and local exit handling can arrive in either order. */
export function applyClosedTerminalLeafNotice(
  tabId: string,
  leafId: string,
  lastPaneCloseReason: TerminalTabCloseIntent
): void {
  const captured = capturedPanesByTabId.get(tabId)
  const pane = captured?.panes.find((candidate) => candidate.leafId === leafId)
  if (pane?.noticeLifetime) {
    const retireNotice = captureTerminalPaneNoticeRetirement({
      tabId,
      leafId,
      worktreeId: captured!.worktreeId,
      lifetime: pane.noticeLifetime
    })
    delete pane.noticeLifetime
    retireNotice()
  }
  if (isTerminalTabParked(tabId)) {
    collapseParkedTerminalLeaf(tabId, leafId)
    return
  }
  const detail: CloseTerminalPaneDetail = { tabId, leafId, lastPaneCloseReason }
  window.dispatchEvent(new CustomEvent(CLOSE_TERMINAL_PANE_EVENT, { detail }))
}
