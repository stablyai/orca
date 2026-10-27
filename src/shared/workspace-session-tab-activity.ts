import type { WorkspaceSessionState } from './workspace-session-state-types'
import { isStructuredTab } from './structured-agent-session-tab'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from './workspace-scope'

type SessionTabs = Pick<WorkspaceSessionState, 'browserTabsByWorktree' | 'unifiedTabs'>

/** Client sessions report browser/native-chat sidebar activity; hosts report live terminals/agents. Read saved session keys, matching renderer getWorktreeIdsWithStructuredChat. */
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

export function getWorkspaceSessionTabActivityIds(
  session: SessionTabs | null | undefined
): Set<string> {
  const { browser, structuredChat } = getWorkspaceSessionTabActivity(session)
  return new Set([...browser, ...structuredChat])
}
