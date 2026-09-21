import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import type { DashboardRevealAgentArgs } from '../../../../shared/dashboard-snapshot'

/**
 * Click-to-focus from either Agent Dashboard surface (pop-out relay or in-window drawer).
 *
 * Why the workspace dispatcher rather than a bare `setActiveWorktree`: only the shared
 * sequence switches the view back to terminal, resumes sleeping agent sessions, and seeds a
 * terminal surface. A parked SSH workspace has no resident tab until those run, so the bare
 * call revealed a workspace with nothing in it (#16731).
 */
export function revealDashboardAgent(args: DashboardRevealAgentArgs): boolean {
  const activated = activateAndRevealWorkspace(
    args.worktreeId,
    args.executionHostId ? { executionHostId: args.executionHostId } : undefined
  )
  if (activated === false) {
    return false
  }
  activateTabAndFocusPane(args.tabId, args.leafId, { flashFocusedPane: true })
  return true
}
