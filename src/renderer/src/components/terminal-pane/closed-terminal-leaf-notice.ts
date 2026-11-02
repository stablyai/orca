import { CLOSE_TERMINAL_PANE_EVENT, type CloseTerminalPaneDetail } from '@/constants/terminal'
import { collapseParkedTerminalLeaf } from './terminal-parked-pty-watcher'
import { isTerminalTabParked } from './terminal-parked-watcher-registry'
import { cancelQueuedTerminalPaneSplitForLeaf } from './terminal-pane-split-request-routing'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

/**
 * Drops a split pane main already closed. Addressed by leaf, so it is a no-op once the pane's own
 * exit handling removed it, and the exit is a no-op after it: whichever lands first wins.
 */
export function applyClosedTerminalLeafNotice(tabId: string, leafId: string): void {
  // Switch point: main wrote a split's pane before its tab mounted; closed meanwhile, it mounts never.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    cancelQueuedTerminalPaneSplitForLeaf(tabId, leafId)
  }
  if (isTerminalTabParked(tabId)) {
    collapseParkedTerminalLeaf(tabId, leafId)
    return
  }
  const detail: CloseTerminalPaneDetail = { tabId, leafId }
  window.dispatchEvent(new CustomEvent(CLOSE_TERMINAL_PANE_EVENT, { detail }))
}
