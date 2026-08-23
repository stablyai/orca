import type { WorkspaceSessionState } from './workspace-session-state-types'

type WindowSessionTerminalMembershipState = Pick<
  WorkspaceSessionState,
  'tabsByWorktree' | 'unifiedTabs' | 'terminalLayoutsByTabId' | 'remoteSessionIdsByTabId'
>

export function collectWindowSessionTerminalTabIds(
  session: WindowSessionTerminalMembershipState
): Set<string> {
  const tabIds = new Set<string>()
  for (const tabs of Object.values(session.tabsByWorktree)) {
    for (const tab of tabs) {
      tabIds.add(tab.id)
    }
  }
  for (const tabs of Object.values(session.unifiedTabs ?? {})) {
    for (const tab of tabs) {
      if (tab.contentType === 'terminal') {
        tabIds.add(tab.entityId)
      }
    }
  }
  for (const tabId of Object.keys(session.terminalLayoutsByTabId)) {
    tabIds.add(tabId)
  }
  for (const tabId of Object.keys(session.remoteSessionIdsByTabId ?? {})) {
    tabIds.add(tabId)
  }
  return tabIds
}
