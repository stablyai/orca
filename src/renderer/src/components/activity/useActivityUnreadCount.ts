import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

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

  // Why no worktree.isUnread here: Activity lists only agent threads, so a worktree
  // unread would light a badge with no row to read and no way to clear it.
  const countEntry = (entry: AgentStatusEntry, ackAt: number, live = false): void => {
    // Why: "Clear completed" hides events at or before the pane's cutoff from the feed,
    // so a hidden event must not keep the badge lit; treat the cutoff like an ack floor.
    const clearedAt = source.activityClearedAtByPaneKey?.[entry.paneKey] ?? 0
    const mutedAt = Math.max(ackAt, clearedAt)
    // Why: Activity feed surfaces historical done/blocked/waiting events
    // from stateHistory, so the titlebar badge must mirror that event count.
    for (const history of entry.stateHistory) {
      if (isHistoricalActivityState(history.state) && mutedAt < history.startedAt) {
        count += 1
      }
    }
    // Why: a session-boundary done is an idle connect (STA-3386), not an event to read.
    // Why 'working' only: a monitoring turn surfaces through the live snapshot, never as an
    // unread event, so counting it here would light the badge with no unread row to clear.
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

export function useActivityUnreadCount(): number {
  const {
    agentStatusEpoch,
    migrationUnsupportedByPtyId,
    retainedAgentsByPaneKey,
    acknowledgedAgentsByPaneKey,
    activityClearedAtByPaneKey
  } = useAppStore(
    useShallow((state) => ({
      // Why not the status map: the receipt is keyed on stateStartedAt, so same-turn heartbeats
      // cannot change the count. The live reducer bumps this epoch on state/turn changes and when
      // a stale entry revives; the freshness scheduler bumps it at the stale boundary.
      agentStatusEpoch: state.agentStatusEpoch,
      migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
      retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
      acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey,
      activityClearedAtByPaneKey: state.activityClearedAtByPaneKey
    }))
  )

  return useMemo(() => {
    void agentStatusEpoch
    return countActivityUnread({
      agentStatusByPaneKey: useAppStore.getState().agentStatusByPaneKey,
      migrationUnsupportedByPtyId,
      retainedAgentsByPaneKey,
      acknowledgedAgentsByPaneKey,
      activityClearedAtByPaneKey
    })
  }, [
    acknowledgedAgentsByPaneKey,
    activityClearedAtByPaneKey,
    migrationUnsupportedByPtyId,
    retainedAgentsByPaneKey,
    agentStatusEpoch
  ])
}
