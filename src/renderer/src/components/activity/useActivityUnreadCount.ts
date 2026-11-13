import { useState } from 'react'

import { migrationUnsupportedToAgentStatusEntry } from '../../../../shared/migration-unsupported-agent-entry'
import { useAppStore } from '@/store'
import { createAgentStatusEpochSelector } from '@/lib/agent-status/evidence/agent-status-epoch-selector'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'

import { freshActivityLiveAgentState, isHistoricalActivityState } from './activity-event-state'

type ActivityUnreadCountSource = Pick<
  AppState,
  | 'acknowledgedAgentsByPaneKey'
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
> & {
  /** Per-pane "Clear completed" cutoffs; hidden events must not count as unread. */
  activityClearedAtByPaneKey?: Record<string, number>
}

/** Counts unread historical activity and fresh current turns. */
export function countActivityUnread(source: ActivityUnreadCountSource, now = Date.now()): number {
  let count = 0
  const seenPaneKeys = new Set<string>()

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

  for (const [paneKey, entry] of Object.entries(source.agentStatusByPaneKey)) {
    seenPaneKeys.add(paneKey)
    countEntry(entry, source.acknowledgedAgentsByPaneKey[paneKey] ?? 0, true)
  }
  for (const [paneKey, retained] of Object.entries(source.retainedAgentsByPaneKey)) {
    // Live status is the primary source; retained is a handoff cache and may briefly overlap it.
    if (seenPaneKeys.has(paneKey)) {
      continue
    }
    seenPaneKeys.add(paneKey)
    countEntry(retained.entry, source.acknowledgedAgentsByPaneKey[paneKey] ?? 0)
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
      retainedAgentsByPaneKey: AppState['retainedAgentsByPaneKey'],
      acknowledgedAgentsByPaneKey: AppState['acknowledgedAgentsByPaneKey'],
      activityClearedAtByPaneKey: AppState['activityClearedAtByPaneKey']
    ) =>
      countActivityUnread({
        agentStatusByPaneKey: state.agentStatusByPaneKey,
        migrationUnsupportedByPtyId,
        retainedAgentsByPaneKey,
        acknowledgedAgentsByPaneKey,
        activityClearedAtByPaneKey
      })
  )

export function useActivityUnreadCount(): number {
  const [selectActivityUnreadCount] = useState(createActivityUnreadCountSelector)
  return useAppStore((state) =>
    selectActivityUnreadCount(
      state,
      state.migrationUnsupportedByPtyId,
      state.retainedAgentsByPaneKey,
      state.acknowledgedAgentsByPaneKey,
      state.activityClearedAtByPaneKey
    )
  )
}
