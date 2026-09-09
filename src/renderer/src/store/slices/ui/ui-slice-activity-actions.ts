import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import {
  collectAcknowledgedAgentNotificationId,
  latestAgentTurnTimestamp,
  resolvePaneKeyWorktreeIdFromTabs,
  usableTimestamp
} from './ui-slice-agent-notification-acknowledgement'

type ActivityActions = Pick<
  UISlice,
  | 'acknowledgedAgentsByPaneKey'
  | 'acknowledgeAgents'
  | 'unacknowledgeAgents'
  | 'activityClearedAtByPaneKey'
  | 'applyActivityClearedAt'
  | 'manuallyUnreadTurnsByPaneKey'
  | 'clearManuallyUnreadTurns'
>

export function createUiActivityActions(set: UISliceSet, _get: UISliceGet): ActivityActions {
  return {
    acknowledgedAgentsByPaneKey: {},
    acknowledgeAgents: (paneKeys) => {
      const notificationIdsToDismiss = new Set<string>()
      set((s) => {
        if (paneKeys.length === 0) {
          return s
        }
        const now = Date.now()
        const migrationUnsupported = Object.values(s.migrationUnsupportedByPtyId ?? {})
        let next: Record<string, number> | null = null
        let nextUnreadCompletions: Record<string, true> | null = null
        for (const key of paneKeys) {
          if (s.unreadAgentCompletionPanes[key]) {
            nextUnreadCompletions ??= { ...s.unreadAgentCompletionPanes }
            delete nextUnreadCompletions[key]
          }
          const prev = s.acknowledgedAgentsByPaneKey[key] ?? 0
          let stamp = now
          const liveEntry = s.agentStatusByPaneKey?.[key]
          if (liveEntry) {
            collectAcknowledgedAgentNotificationId({
              ids: notificationIdsToDismiss,
              worktreeId: resolvePaneKeyWorktreeIdFromTabs(s, key) ?? liveEntry.worktreeId,
              paneKey: key,
              stateStartedAt: liveEntry.stateStartedAt,
              previousAckAt: prev
            })
            stamp = Math.max(stamp, latestAgentTurnTimestamp(liveEntry))
          }
          const retained = s.retainedAgentsByPaneKey?.[key]
          if (retained) {
            collectAcknowledgedAgentNotificationId({
              ids: notificationIdsToDismiss,
              worktreeId: retained.worktreeId,
              paneKey: key,
              stateStartedAt: retained.entry.stateStartedAt,
              previousAckAt: prev
            })
            stamp = Math.max(stamp, latestAgentTurnTimestamp(retained.entry))
          }
          for (const unsupported of migrationUnsupported) {
            if (unsupported.paneKey === key) {
              stamp = Math.max(stamp, usableTimestamp(unsupported.updatedAt))
            }
          }
          if (prev < stamp) {
            next ??= { ...s.acknowledgedAgentsByPaneKey }
            next[key] = stamp
          }
        }
        let nextManual: Record<string, number> | null = null
        for (const key of paneKeys) {
          if (s.manuallyUnreadTurnsByPaneKey[key] !== undefined) {
            nextManual ??= { ...s.manuallyUnreadTurnsByPaneKey }
            delete nextManual[key]
          }
        }
        if (!next && !nextUnreadCompletions && !nextManual) {
          return s
        }
        return {
          ...(next ? { acknowledgedAgentsByPaneKey: next } : {}),
          ...(nextUnreadCompletions ? { unreadAgentCompletionPanes: nextUnreadCompletions } : {}),
          ...(nextManual ? { manuallyUnreadTurnsByPaneKey: nextManual } : {})
        }
      })
      const ids = [...notificationIdsToDismiss]
      if (ids.length > 0 && typeof window !== 'undefined') {
        void window.api?.notifications?.dismiss?.(ids)
      }
    },
    unacknowledgeAgents: (paneKeys) =>
      set((s) => {
        if (paneKeys.length === 0) {
          return s
        }
        let next: Record<string, number> | null = null
        let nextManual: Record<string, number> | null = null
        for (const key of paneKeys) {
          if (s.acknowledgedAgentsByPaneKey[key] !== undefined) {
            next ??= { ...s.acknowledgedAgentsByPaneKey }
            delete next[key]
          }
          const turnTimestamp =
            s.agentStatusByPaneKey?.[key]?.stateStartedAt ??
            s.retainedAgentsByPaneKey?.[key]?.entry.stateStartedAt
          if (
            turnTimestamp !== undefined &&
            s.manuallyUnreadTurnsByPaneKey[key] !== turnTimestamp
          ) {
            nextManual ??= { ...s.manuallyUnreadTurnsByPaneKey }
            nextManual[key] = turnTimestamp
          }
        }
        if (!next && !nextManual) {
          return s
        }
        return {
          ...(next ? { acknowledgedAgentsByPaneKey: next } : {}),
          ...(nextManual ? { manuallyUnreadTurnsByPaneKey: nextManual } : {})
        }
      }),
    manuallyUnreadTurnsByPaneKey: {},
    clearManuallyUnreadTurns: (paneKeys) =>
      set((s) => {
        let next: Record<string, number> | null = null
        for (const key of paneKeys) {
          if (s.manuallyUnreadTurnsByPaneKey[key] !== undefined) {
            next ??= { ...s.manuallyUnreadTurnsByPaneKey }
            delete next[key]
          }
        }
        return next ? { manuallyUnreadTurnsByPaneKey: next } : s
      }),
    activityClearedAtByPaneKey: {},
    applyActivityClearedAt: (patch) =>
      set((s) => {
        let next: Record<string, number> | null = null
        for (const [key, value] of Object.entries(patch)) {
          const previous = s.activityClearedAtByPaneKey[key]
          if (value === null ? previous === undefined : previous === value) {
            continue
          }
          next ??= { ...s.activityClearedAtByPaneKey }
          if (value === null) {
            delete next[key]
          } else {
            next[key] = value
          }
        }
        return next ? { activityClearedAtByPaneKey: next } : s
      })
  }
}
