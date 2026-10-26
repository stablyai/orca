import type { StoredAgentAttentionUnread } from '@/attention/agent-attention-contract'
import { structuredAgentSessionPaneKey } from '../../../../../shared/structured-agent-session-projection'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import type { Tab } from '../../../../../shared/tab-types'

// Only markers owned by live tabs count; closed tabs and superseded sessions cannot light or hold workspace dots.

type MarkerRecord = Readonly<Record<string, StoredAgentAttentionUnread>>

export type LiveMarkerSources = {
  tabsByWorktree?: Readonly<Record<string, readonly Pick<TerminalTab, 'id'>[]>>
  /** `entityId` names a chat's current session; readers without it (the Dock) skip completions. */
  unifiedTabsByWorktree?: Readonly<
    Record<string, readonly (Pick<Tab, 'id' | 'contentType'> & { entityId?: string })[]>
  >
  unreadTerminalTabs?: MarkerRecord
}

/** A tab that can own markers: a terminal tab, or a structured chat with its current session. */
export type MarkerTab = { id: string; sessionId: string | null }

/** Pane keys are `${tabId}:${leafId}` and tab ids never contain ":". */
export function paneKeyTabId(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  return separator > 0 ? paneKey.slice(0, separator) : null
}

/** The tabs of a workspace that can own a marker. */
export function workspaceMarkerTabs(sources: LiveMarkerSources, workspaceId: string): MarkerTab[] {
  const tabs: MarkerTab[] = (sources.tabsByWorktree?.[workspaceId] ?? []).map((tab) => ({
    id: tab.id,
    sessionId: null
  }))
  for (const tab of sources.unifiedTabsByWorktree?.[workspaceId] ?? []) {
    if (tab.contentType === 'agent-session') {
      tabs.push({ id: tab.id, sessionId: tab.entityId ?? null })
    }
  }
  return tabs
}

/** A tab marker on a live terminal or structured chat tab — the Dock's folder rule. */
export function hasLiveTabMarker(sources: LiveMarkerSources, workspaceId: string): boolean {
  return workspaceMarkerTabs(sources, workspaceId).some((tab) =>
    Boolean(sources.unreadTerminalTabs?.[tab.id])
  )
}

export function workspaceMarkerTabIds(
  sources: LiveMarkerSources,
  workspaceId: string
): Set<string> {
  return new Set(workspaceMarkerTabs(sources, workspaceId).map((tab) => tab.id))
}

/** What the workspace flag follows: a tab or completion marker on a live tab. */
export function workspaceHasLiveMarker(
  sources: LiveMarkerSources & { unreadAgentCompletionPanes: MarkerRecord },
  workspaceId: string
): boolean {
  const completionTabIds = new Set(
    Object.keys(sources.unreadAgentCompletionPanes).map(paneKeyTabId)
  )
  return workspaceMarkerTabs(sources, workspaceId).some(
    (tab) =>
      Boolean(sources.unreadTerminalTabs?.[tab.id]) ||
      // Why the current session's key only: a tab rebound to a new session no longer owns the old one.
      (tab.sessionId === null
        ? completionTabIds.has(tab.id)
        : Boolean(
            sources.unreadAgentCompletionPanes[structuredAgentSessionPaneKey(tab.id, tab.sessionId)]
          ))
  )
}
