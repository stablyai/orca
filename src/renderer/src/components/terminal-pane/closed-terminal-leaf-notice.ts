import { CLOSE_TERMINAL_PANE_EVENT, type CloseTerminalPaneDetail } from '@/constants/terminal'
import { collapseParkedTerminalLeaf } from './terminal-parked-pty-watcher'
import { isTerminalTabParked } from './terminal-parked-watcher-registry'

/** Remove main-closed leaves idempotently so this notice and local exit handling can arrive in either order. */
export function applyClosedTerminalLeafNotice(tabId: string, leafId: string): void {
  if (isTerminalTabParked(tabId)) {
    collapseParkedTerminalLeaf(tabId, leafId)
    return
  }
  const detail: CloseTerminalPaneDetail = { tabId, leafId }
  window.dispatchEvent(new CustomEvent(CLOSE_TERMINAL_PANE_EVENT, { detail }))
}
