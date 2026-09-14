import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import {
  activateStructuredAgentSessionById,
  activateStructuredAgentSessionTab
} from '@/lib/structured-agent-session-tab-activation'
import {
  isDashboardStructuredChatCard,
  type DashboardRevealAgentArgs
} from '../../../../shared/dashboard-snapshot'

/**
 * Click-to-focus from either Agent Dashboard surface (pop-out relay or in-window drawer).
 *
 * Why the workspace dispatcher rather than a bare `setActiveWorktree`: only the shared
 * sequence switches the view back to terminal, resumes sleeping agent sessions, and seeds a
 * terminal surface. A parked SSH workspace has no resident tab until those run, so the bare
 * call revealed a workspace with nothing in it (#16731).
 *
 * Structured/native chat cards have no PTY by design. Routing them through
 * `activateTabAndFocusPane` forces the terminal surface and looks like a closed pane.
 */
export function revealDashboardAgent(args: DashboardRevealAgentArgs): boolean {
  const activated = activateAndRevealWorkspace(
    args.worktreeId,
    args.executionHostId ? { executionHostId: args.executionHostId } : undefined
  )
  if (activated === false) {
    return false
  }
  if (isDashboardStructuredChatCard({ surfaceKind: args.surfaceKind, ptyId: null })) {
    if (
      args.structuredSessionId &&
      activateStructuredAgentSessionById({
        worktreeId: args.worktreeId,
        sessionId: args.structuredSessionId
      })
    ) {
      return true
    }
    activateStructuredAgentSessionTab({ worktreeId: args.worktreeId, tabId: args.tabId })
    return true
  }
  activateTabAndFocusPane(args.tabId, args.leafId, { flashFocusedPane: true })
  return true
}
