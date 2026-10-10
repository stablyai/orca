import { CLOSE_TERMINAL_PANE_EVENT, type CloseTerminalPaneDetail } from '@/constants/terminal'
import { collapseParkedTerminalLeaf } from './terminal-parked-pty-watcher'
import { isTerminalTabParked } from './terminal-parked-watcher-registry'

/**
 * Drops a split pane main already closed. Addressed by leaf, so it is a no-op once the pane's own
 * exit handling removed it, and the exit is a no-op after it: whichever lands first wins.
 */
export function applyClosedTerminalLeafNotice(tabId: string, leafId: string): void {
  if (isTerminalTabParked(tabId)) {
    collapseParkedTerminalLeaf(tabId, leafId)
    return
  }
  const detail: CloseTerminalPaneDetail = { tabId, leafId }
  window.dispatchEvent(new CustomEvent(CLOSE_TERMINAL_PANE_EVENT, { detail }))
}
