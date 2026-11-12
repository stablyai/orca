import type { StoredAgentAttentionUnread } from '@/attention/agent-attention-contract'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
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

const completionKeysByTabCache = new WeakMap<MarkerRecord, ReadonlyMap<string, readonly string[]>>()
let previousCompletionKeysByTab: ReadonlyMap<string, readonly string[]> = new Map()

function sameKeys(left: readonly string[], right: readonly string[] | undefined): boolean {
  return (
    right !== undefined &&
    left.length === right.length &&
    left.every((key, index) => key === right[index])
  )
}

/**
 * Completion pane keys grouped by owning tab. Cached per record snapshot (store updates replace the
 * record) so every mounted card shares one O(C) pass instead of rescanning all markers per tab.
 * A tab whose keys did not change keeps its previous array, so per-workspace readers can compare
 * by identity and ignore completions elsewhere.
 */
export function completionPaneKeysByTabId(
  completions: MarkerRecord
): ReadonlyMap<string, readonly string[]> {
  const cached = completionKeysByTabCache.get(completions)
  if (cached) {
    return cached
  }
  const byTab = new Map<string, string[]>()
  for (const key of Object.keys(completions)) {
    const tabId = paneKeyTabId(key)
    if (tabId === null) {
      continue
    }
    const keys = byTab.get(tabId)
    if (keys) {
      keys.push(key)
    } else {
      byTab.set(tabId, [key])
    }
  }
  for (const [tabId, keys] of byTab) {
    const previous = previousCompletionKeysByTab.get(tabId)
    if (previous !== keys && sameKeys(keys, previous)) {
      byTab.set(tabId, previous as string[])
    }
  }
  completionKeysByTabCache.set(completions, byTab)
  previousCompletionKeysByTab = byTab
  return byTab
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

/** The live tabs holding a tab or completion marker: where the workspace's unread actually is. */
export function workspaceLiveMarkerTabIds(
  sources: LiveMarkerSources & { unreadAgentCompletionPanes: MarkerRecord },
  workspaceId: string
): string[] {
  const completionTabIds = completionPaneKeysByTabId(sources.unreadAgentCompletionPanes)
  return workspaceMarkerTabs(sources, workspaceId)
    .filter(
      (tab) =>
        Boolean(sources.unreadTerminalTabs?.[tab.id]) ||
        // Why the current session's key only: a tab rebound to a new session no longer owns the old one.
        (tab.sessionId === null
          ? completionTabIds.has(tab.id)
          : Boolean(
              sources.unreadAgentCompletionPanes[
                structuredAgentSessionPaneKey(tab.id, tab.sessionId)
              ]
            ))
    )
    .map((tab) => tab.id)
}

/** What the workspace flag follows: a tab or completion marker on a live tab. */
export function workspaceHasLiveMarker(
  sources: LiveMarkerSources & { unreadAgentCompletionPanes: MarkerRecord },
  workspaceId: string
): boolean {
  return workspaceLiveMarkerTabIds(sources, workspaceId).length > 0
}
