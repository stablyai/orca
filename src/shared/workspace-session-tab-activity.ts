import type { WorkspaceSessionState } from './workspace-session-state-types'
import { isStructuredTab } from './structured-agent-session-tab'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from './workspace-scope'

type SessionTabs = Pick<WorkspaceSessionState, 'browserTabsByWorktree' | 'unifiedTabs'>

/**
 * Workspaces a saved session holds open browser or native-chat tabs for: the two signals of the
 * desktop sidebar's activity rule (worktree-activity-state.ts) that live in the client's session
 * rather than on the execution host. Live terminals and agents are the host's to report. Reads
 * the saved session's keys; the renderer's live-state twin is getWorktreeIdsWithStructuredChat.
 */
export function getWorkspaceSessionTabActivity(session: SessionTabs | null | undefined): {
  browser: Set<string>
  structuredChat: Set<string>
} {
  const browser = new Set<string>()
  const structuredChat = new Set<string>()
  for (const [key, tabs] of Object.entries(session?.browserTabsByWorktree ?? {})) {
    if (tabs.length > 0) {
      browser.add(normalizeWorkspaceSessionKeyToWorkspaceId(key))
    }
  }
  for (const [key, tabs] of Object.entries(session?.unifiedTabs ?? {})) {
    if (tabs.some(isStructuredTab)) {
      structuredChat.add(normalizeWorkspaceSessionKeyToWorkspaceId(key))
    }
  }
  return { browser, structuredChat }
}

/** Either kind of getWorkspaceSessionTabActivity. */
export function getWorkspaceSessionTabActivityIds(
  session: SessionTabs | null | undefined
): Set<string> {
  const { browser, structuredChat } = getWorkspaceSessionTabActivity(session)
  return new Set([...browser, ...structuredChat])
}
