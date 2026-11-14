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

/** Visits each unread Activity event; `liveWorking` marks a fresh running turn rather than a finished or blocked one. */
function visitActivityUnread(
  source: ActivityUnreadCountSource,
  now: number,
  visit: (paneKey: string, liveWorking: boolean) => void
): void {
  const seenPaneKeys = new Set<string>()

  // Workspace unread flags have no Activity row to clear and must not light this badge.
  const visitEntry = (entry: AgentStatusEntry, ackAt: number, live = false): void => {
    // Treat Clear completed’s per-pane cutoff as an acknowledgement floor so hidden events cannot keep the badge lit.
    const clearedAt = source.activityClearedAtByPaneKey?.[entry.paneKey] ?? 0
    const mutedAt = Math.max(ackAt, clearedAt)
    // Mirror the feed’s historical done/blocked/waiting event count.
    for (const history of entry.stateHistory) {
      if (isHistoricalActivityState(history.state) && mutedAt < history.startedAt) {
        visit(entry.paneKey, false)
      }
    }
    // Session-boundary idle connects (STA-3386) and monitoring snapshots create no unread events, so counting either would leave a badge with no row to clear.
    const historical = isHistoricalActivityState(entry.state)
    if (
      (historical || (live && freshActivityLiveAgentState(entry, now) === 'working')) &&
      entry.sessionBoundary !== true &&
      mutedAt < entry.stateStartedAt
    ) {
      visit(entry.paneKey, !historical)
    }
  }

  for (const [paneKey, entry] of Object.entries(source.agentStatusByPaneKey)) {
    seenPaneKeys.add(paneKey)
    visitEntry(entry, source.acknowledgedAgentsByPaneKey[paneKey] ?? 0, true)
  }
  for (const [paneKey, retained] of Object.entries(source.retainedAgentsByPaneKey)) {
    // Live status is the primary source; retained is a handoff cache and may briefly overlap it.
    if (seenPaneKeys.has(paneKey)) {
      continue
    }
    seenPaneKeys.add(paneKey)
    visitEntry(retained.entry, source.acknowledgedAgentsByPaneKey[paneKey] ?? 0)
  }
  for (const unsupported of Object.values(source.migrationUnsupportedByPtyId)) {
    const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
    if (entry && !seenPaneKeys.has(entry.paneKey)) {
      seenPaneKeys.add(entry.paneKey)
      visitEntry(entry, source.acknowledgedAgentsByPaneKey[entry.paneKey] ?? 0)
    }
  }
}

/** Counts unread historical activity and fresh current turns. */
export function countActivityUnread(source: ActivityUnreadCountSource, now = Date.now()): number {
  let count = 0
  visitActivityUnread(source, now, () => {
    count += 1
  })
  return count
}

/** Counts chats with a finished or blocked turn the user has not seen; running turns are not ready to read. */
export function countActivityUnreadChats(
  source: ActivityUnreadCountSource,
  now = Date.now()
): number {
  const paneKeys = new Set<string>()
  visitActivityUnread(source, now, (paneKey, liveWorking) => {
    if (!liveWorking) {
      paneKeys.add(paneKey)
    }
  })
  return paneKeys.size
}

// Same-turn heartbeats preserve receipts; reducer/freshness epoch changes cover turn/state changes, stale revival and expiry.
const createActivityUnreadSelector = (
  count: (source: ActivityUnreadCountSource) => number
): ((state: AppState) => number) => {
  const select = createAgentStatusEpochSelector(
    (
      state: AppState,
      migrationUnsupportedByPtyId: AppState['migrationUnsupportedByPtyId'],
      retainedAgentsByPaneKey: AppState['retainedAgentsByPaneKey'],
      acknowledgedAgentsByPaneKey: AppState['acknowledgedAgentsByPaneKey'],
      activityClearedAtByPaneKey: AppState['activityClearedAtByPaneKey']
    ) =>
      count({
        agentStatusByPaneKey: state.agentStatusByPaneKey,
        migrationUnsupportedByPtyId,
        retainedAgentsByPaneKey,
        acknowledgedAgentsByPaneKey,
        activityClearedAtByPaneKey
      })
  )
  return (state) =>
    select(
      state,
      state.migrationUnsupportedByPtyId,
      state.retainedAgentsByPaneKey,
      state.acknowledgedAgentsByPaneKey,
      state.activityClearedAtByPaneKey
    )
}

/** Selects the number of unread chats, for the Dock badge. */
export function createActivityUnreadChatCountSelector(): (state: AppState) => number {
  return createActivityUnreadSelector((source) => countActivityUnreadChats(source))
}

export function useActivityUnreadCount(): number {
  const [selectActivityUnreadCount] = useState(() =>
    createActivityUnreadSelector((source) => countActivityUnread(source))
  )
  return useAppStore(selectActivityUnreadCount)
}
