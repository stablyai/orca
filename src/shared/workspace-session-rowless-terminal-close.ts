import type { WorkspaceSessionState } from './workspace-session-state-types'

type RowlessTerminalBackingCloseResult = {
  session: WorkspaceSessionState
  ptyIdsToKill: string[]
  closed: boolean
  pinned: false
}

export function collectWorkspaceSessionTerminalPtyIds(
  session: WorkspaceSessionState,
  tabId: string,
  rowPtyId?: string | null
): Set<string> {
  const ids = new Set<string>()
  if (rowPtyId) {
    ids.add(rowPtyId)
  }
  for (const ptyId of Object.values(session.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {})) {
    ids.add(ptyId)
  }
  const remoteSessionId = session.remoteSessionIdsByTabId?.[tabId]
  if (remoteSessionId) {
    ids.add(remoteSessionId)
  }
  return ids
}

export function closeRowlessTerminalBacking(
  session: WorkspaceSessionState,
  tabId: string
): RowlessTerminalBackingCloseResult | null {
  if (
    !Object.hasOwn(session.terminalLayoutsByTabId, tabId) &&
    !Object.hasOwn(session.remoteSessionIdsByTabId ?? {}, tabId)
  ) {
    return null
  }
  const otherTabIds = new Set(Object.keys(session.terminalLayoutsByTabId))
  for (const tabs of Object.values(session.tabsByWorktree)) {
    for (const tab of tabs) {
      otherTabIds.add(tab.id)
    }
  }
  otherTabIds.delete(tabId)
  const otherPtyIds = new Set<string>()
  for (const otherTabId of otherTabIds) {
    for (const ptyId of collectWorkspaceSessionTerminalPtyIds(session, otherTabId)) {
      otherPtyIds.add(ptyId)
    }
  }
  const ptyIdsToKill = [...collectWorkspaceSessionTerminalPtyIds(session, tabId)].filter(
    (ptyId) => !otherPtyIds.has(ptyId)
  )
  const next: WorkspaceSessionState = {
    ...session,
    terminalLayoutsByTabId: { ...session.terminalLayoutsByTabId },
    remoteSessionIdsByTabId: { ...session.remoteSessionIdsByTabId },
    sleepingAgentSessionsByPaneKey: { ...session.sleepingAgentSessionsByPaneKey }
  }
  delete next.terminalLayoutsByTabId[tabId]
  delete next.remoteSessionIdsByTabId![tabId]
  for (const [paneKey, record] of Object.entries(next.sleepingAgentSessionsByPaneKey ?? {})) {
    if (paneKey.startsWith(`${tabId}:`) || record.tabId === tabId) {
      delete next.sleepingAgentSessionsByPaneKey![paneKey]
    }
  }
  return { session: next, ptyIdsToKill, closed: true, pinned: false }
}
