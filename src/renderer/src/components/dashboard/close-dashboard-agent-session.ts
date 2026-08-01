import { useAppStore } from '@/store'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { resolveTerminalCloseTarget } from '@/components/terminal/terminal-close-target'
import type { DashboardCloseAgentArgs } from '../../../../shared/dashboard-snapshot'

/**
 * Close a CLI agent session from a dashboard surface (sidebar row or, relayed
 * over IPC, the pop-out board). Closing kills the WHOLE terminal tab — split
 * panes and any sibling agents included — via the canonical closeTerminalTab
 * (PTY kill, host routing, pinned guard). When the tab is already gone the row
 * is dead state, so it is just dismissed.
 */
export function closeDashboardAgentSession(args: DashboardCloseAgentArgs): void {
  const state = useAppStore.getState()
  if (args.tabId !== null && resolveTerminalCloseTarget(state, args.tabId, undefined)) {
    closeTerminalTab(args.tabId, { reason: 'user' })
    return
  }
  state.dropAgentStatus(args.paneKey)
  state.dismissRetainedAgent(args.paneKey)
}
