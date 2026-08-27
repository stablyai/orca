import { useAppStore } from '@/store'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { closeWebRuntimeTerminal } from '@/runtime/web-runtime-session'
import type { DashboardStopAgentArgs } from '../../../shared/dashboard-snapshot'

/** Kills the PTY behind one agent pane, matching TerminalPane's own split-pane
 *  teardown order: host-owned runtime terminals first, local/SSH otherwise. */
function killAgentPane(ptyId: string): void {
  if (closeWebRuntimeTerminal(ptyId)) {
    return
  }
  void window.api.pty.kill(ptyId)
}

function paneCountForTab(tabId: string): number {
  const layout = useAppStore.getState().terminalLayoutsByTabId[tabId]
  return Object.keys(layout?.ptyIdsByLeafId ?? {}).length
}

/**
 * Stops one agent from the pop-out board: kills its process and takes its row
 * off the board. Runs in the MAIN renderer — the pop-out has no store of its
 * own — and never activates the worktree, so the board stays put.
 */
export function stopDashboardAgent(args: DashboardStopAgentArgs): void {
  const state = useAppStore.getState()
  // Why: drop the live row BEFORE the pane dies so dropAgentStatus plants its
  // retention suppressor while a live entry still exists; otherwise the
  // retention sync re-adds the agent as a retained "done" row and the card
  // never actually leaves the board.
  state.dropAgentStatus(args.paneKey)
  state.dismissRetainedAgent(args.paneKey)

  if (!args.ptyId) {
    // Retained card whose pane is already gone — the row was the only thing left.
    return
  }

  // A split tab hosts other panes the user didn't ask to close, so kill just
  // this agent's PTY and leave the tab standing.
  if (paneCountForTab(args.tabId) > 1) {
    killAgentPane(args.ptyId)
    return
  }

  const ptyId = args.ptyId
  closeTerminalTab(args.tabId, {
    reason: 'user',
    // Why: the pinned-close confirmation would open a modal in the main window,
    // which is behind the board and may be unattended. Stop the agent anyway
    // and leave the pinned tab itself alone — silently doing nothing would read
    // as a broken button.
    rejectPinned: true,
    onCancel: () => killAgentPane(ptyId)
  })
}
