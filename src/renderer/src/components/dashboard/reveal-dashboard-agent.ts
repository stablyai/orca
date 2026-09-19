import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import {
  activateStructuredAgentSessionById,
  activateStructuredAgentSessionTab
} from '@/lib/structured-agent-session-tab-activation'
import type { DashboardRevealAgentArgs } from '../../../../shared/dashboard-snapshot'
import { structuredAgentSessionIdFromTabId } from '../../../../shared/structured-agent-session-projection'

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
  if (args.surfaceKind !== 'structured-chat') {
    activateTabAndFocusPane(args.tabId, args.leafId, { flashFocusedPane: true })
    return true
  }
  const sessionId = args.structuredSessionId ?? structuredAgentSessionIdFromTabId(args.tabId)
  if (
    sessionId &&
    activateStructuredAgentSessionById({
      worktreeId: args.worktreeId,
      sessionId
    })
  ) {
    return true
  }
  if (activateStructuredAgentSessionTab({ worktreeId: args.worktreeId, tabId: args.tabId })) {
    return true
  }
  // Host-owned cards can exist without a mounted tab; republish instead of faking success.
  if (!sessionId) {
    return false
  }
  void activateAiVaultStructuredSession({
    structuredSession: { workspaceId: args.worktreeId, sessionId }
  })
  return true
}
