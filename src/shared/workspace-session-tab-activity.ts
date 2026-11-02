import type { WorkspaceSessionState } from './workspace-session-state-types'
import { isStructuredTab } from './structured-agent-session-tab'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from './workspace-scope'

/**
 * Workspaces a saved session holds open browser or native-chat tabs for: the two signals of the
 * desktop sidebar's activity rule (worktree-activity-state.ts) that live in the client's session
 * rather than on the execution host. Live terminals and agents are the host's to report. Reads
 * the saved session's keys; the renderer's live-state twin is getWorktreeIdsWithStructuredChat.
 */
export function getWorkspaceSessionTabActivityIds(
  session: Pick<WorkspaceSessionState, 'browserTabsByWorktree' | 'unifiedTabs'> | null | undefined
): Set<string> {
  const ids = new Set<string>()
  for (const [key, tabs] of Object.entries(session?.browserTabsByWorktree ?? {})) {
    if (tabs.length > 0) {
      ids.add(normalizeWorkspaceSessionKeyToWorkspaceId(key))
    }
  }
  for (const [key, tabs] of Object.entries(session?.unifiedTabs ?? {})) {
    if (tabs.some(isStructuredTab)) {
      ids.add(normalizeWorkspaceSessionKeyToWorkspaceId(key))
    }
  }
  return ids
}
