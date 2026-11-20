import { useState } from 'react'

import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { parseAgentStatusPaneIdentity } from '../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { migrationUnsupportedToAgentStatusEntry } from '../../../../../shared/agent-status/presentation/migration-unsupported-agent-entry'
import { useAppStore } from '@/store'
import { createAgentStatusEpochSelector } from '@/lib/agent-status/evidence/agent-status-epoch-selector'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'

import { freshActivityLiveAgentState, isHistoricalActivityState } from './activity-event-state'

type ActivityUnreadCountSource = Pick<
  AppState,
  'acknowledgedAgentsByPaneKey' | 'agentStatusByPaneKey' | 'migrationUnsupportedByPtyId'
> & {
  /** Per-pane "Clear completed" cutoffs; hidden events must not count as unread. */
  activityClearedAtByPaneKey?: Record<string, number>
  tabsByWorktree?: AppState['tabsByWorktree']
  unifiedTabsByWorktree?: AppState['unifiedTabsByWorktree']
}

function collectOpenActivityTabIds(
  tabsByWorktree?: AppState['tabsByWorktree'],
  unifiedTabsByWorktree?: AppState['unifiedTabsByWorktree']
): Set<string> | null {
  if (tabsByWorktree === undefined && unifiedTabsByWorktree === undefined) {
    return null
  }
  const openTabIds = new Set<string>()
  for (const tabs of Object.values(tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      openTabIds.add(tab.id)
    }
  }
  for (const tabs of Object.values(unifiedTabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (tab.contentType === 'agent-session') {
        openTabIds.add(tab.id)
      }
    }
  }
  return openTabIds
}

/** Counts unread historical activity and fresh current turns. */
export function countActivityUnread(source: ActivityUnreadCountSource, now = Date.now()): number {
  let count = 0
  const seenPaneKeys = new Set<string>()
  const openTabIds = collectOpenActivityTabIds(source.tabsByWorktree, source.unifiedTabsByWorktree)
  const representedTabs = openTabIds
    ? getStructuredAgentSessionTabsByPaneKey(source.unifiedTabsByWorktree)
    : null

  // Workspace unread flags have no Activity row to clear and must not light this badge.
  const countEntry = (entry: AgentStatusEntry, ackAt: number, live = false): void => {
    // Treat Clear completed’s per-pane cutoff as an acknowledgement floor so hidden events cannot keep the badge lit.
    const clearedAt = source.activityClearedAtByPaneKey?.[entry.paneKey] ?? 0
    const mutedAt = Math.max(ackAt, clearedAt)
    // Mirror the feed’s historical done/blocked/waiting event count.
    for (const history of entry.stateHistory) {
      if (isHistoricalActivityState(history.state) && mutedAt < history.startedAt) {
        count += 1
      }
    }
    // Session-boundary idle connects (STA-3386) and monitoring snapshots create no unread events, so counting either would leave a badge with no row to clear.
    if (
      (isHistoricalActivityState(entry.state) ||
        (live && freshActivityLiveAgentState(entry, now) === 'working')) &&
      entry.sessionBoundary !== true &&
      mutedAt < entry.stateStartedAt
    ) {
      count += 1
    }
  }

  for (const [paneKey, entry] of Array.from(source.agentStatusByPaneKey.entries())) {
    if (openTabIds) {
      const parsed = parseAgentStatusPaneIdentity(paneKey, representedTabs?.get(paneKey))
      const hasOpenTab = parsed !== null && openTabIds.has(parsed.tabId)
      if (
        !hasOpenTab &&
        freshActivityLiveAgentState(entry, now) === null &&
        entry.state !== 'blocked' &&
        entry.state !== 'waiting'
      ) {
        continue
      }
    }
    seenPaneKeys.add(paneKey)
    countEntry(entry, source.acknowledgedAgentsByPaneKey[paneKey] ?? 0, true)
  }
  for (const unsupported of Object.values(source.migrationUnsupportedByPtyId)) {
    const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
    if (entry && !seenPaneKeys.has(entry.paneKey)) {
      seenPaneKeys.add(entry.paneKey)
      countEntry(entry, source.acknowledgedAgentsByPaneKey[entry.paneKey] ?? 0)
    }
  }

  return count
}

// Same-turn heartbeats preserve receipts; reducer/freshness epoch changes cover turn/state changes, stale revival and expiry.
const createActivityUnreadCountSelector = () =>
  createAgentStatusEpochSelector(
    (
      state: AppState,
      migrationUnsupportedByPtyId: AppState['migrationUnsupportedByPtyId'],
      acknowledgedAgentsByPaneKey: AppState['acknowledgedAgentsByPaneKey'],
      activityClearedAtByPaneKey: AppState['activityClearedAtByPaneKey'],
      tabsByWorktree: AppState['tabsByWorktree'],
      unifiedTabsByWorktree: AppState['unifiedTabsByWorktree']
    ) =>
      countActivityUnread({
        agentStatusByPaneKey: state.agentStatusByPaneKey,
        migrationUnsupportedByPtyId,
        acknowledgedAgentsByPaneKey,
        activityClearedAtByPaneKey,
        tabsByWorktree,
        unifiedTabsByWorktree
      })
  )

export function useActivityUnreadCount(): number {
  const [selectActivityUnreadCount] = useState(createActivityUnreadCountSelector)
  return useAppStore((state) =>
    selectActivityUnreadCount(
      state,
      state.migrationUnsupportedByPtyId,
      state.acknowledgedAgentsByPaneKey,
      state.activityClearedAtByPaneKey,
      state.tabsByWorktree,
      state.unifiedTabsByWorktree
    )
  )
}
