import type { StoredAgentAttentionUnread } from '@/attention/agent-attention-contract'
import { emitAgentSubjectReads } from '@/attention/agent-subject-read-actions'
import { readManualUnreadProtectionTurn } from '@/attention/agent-attention-acknowledgement'
import { recordDraft } from '@/store/record-transitions/keyed-record-transitions'
import {
  deleteChatReadMark,
  deleteChatReadMarkAliases,
  readWebChatMark
} from '../agent-status/structured-sessions/chat-read-mark-aliases'
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

const ACKNOWLEDGEMENT_REFRESH_MS = 24 * 60 * 60 * 1000

export function createUiActivityActions(set: UISliceSet, _get: UISliceGet): ActivityActions {
  return {
    acknowledgedAgentsByPaneKey: {},
    acknowledgeAgents: (paneKeys, reads, intent) => {
      emitAgentSubjectReads(paneKeys, reads, intent)
      const notificationIdsToDismiss = new Set<string>()
      set((s) => {
        if (paneKeys.length === 0) {
          return s
        }
        const now = Date.now()
        const migrationUnsupported = Object.values(s.migrationUnsupportedByPtyId ?? {})
        const ack = recordDraft(s.acknowledgedAgentsByPaneKey)
        const manual = recordDraft(s.manuallyUnreadTurnsByPaneKey)
        let nextUnreadCompletions: Record<string, StoredAgentAttentionUnread> | null = null
        for (const key of paneKeys) {
          deleteChatReadMarkAliases(ack, 'acknowledgedAgentsByPaneKey', key)
          deleteChatReadMark(manual, 'manuallyUnreadTurnsByPaneKey', key)
          if (s.unreadAgentCompletionPanes[key]) {
            nextUnreadCompletions ??= { ...s.unreadAgentCompletionPanes }
            delete nextUnreadCompletions[key]
          }
          const prev = s.acknowledgedAgentsByPaneKey[key] ?? 0
          let known = 0
          const liveEntry = s.agentStatusByPaneKey.get(key)
          if (liveEntry) {
            collectAcknowledgedAgentNotificationId({
              state: s,
              ids: notificationIdsToDismiss,
              worktreeId: resolvePaneKeyWorktreeIdFromTabs(s, key) ?? liveEntry.worktreeId,
              paneKey: key,
              stateStartedAt: liveEntry.stateStartedAt,
              previousAckAt: prev
            })
            known = latestAgentTurnTimestamp(liveEntry)
          }
          for (const unsupported of migrationUnsupported) {
            if (unsupported.paneKey === key) {
              known = Math.max(known, usableTimestamp(unsupported.updatedAt))
            }
          }
          // A stamp already covering every known turn changes no reader; re-stamping costs a persisted UI write per click.
          // Refresh it once a day anyway so hydration's newest-entries cap can't drop a stamp the user keeps renewing.
          if (
            s.acknowledgedAgentsByPaneKey[key] !== undefined &&
            prev >= known &&
            now - prev < ACKNOWLEDGEMENT_REFRESH_MS
          ) {
            continue
          }
          const stamp = Math.max(now, known)
          if (prev < stamp) {
            ack.set(key, stamp)
          }
        }
        const nextAck = ack.finish()
        const nextManual = manual.finish()
        if (
          nextAck === s.acknowledgedAgentsByPaneKey &&
          nextManual === s.manuallyUnreadTurnsByPaneKey &&
          !nextUnreadCompletions
        ) {
          return s
        }
        return {
          acknowledgedAgentsByPaneKey: nextAck,
          manuallyUnreadTurnsByPaneKey: nextManual,
          ...(nextUnreadCompletions ? { unreadAgentCompletionPanes: nextUnreadCompletions } : {})
        }
      })
      // Dismiss main’s announced subjects; rebuilt IDs cover restart-empty notification records.
      if (paneKeys.length > 0 && typeof window !== 'undefined') {
        void window.api?.notifications?.dismiss?.([...notificationIdsToDismiss], paneKeys)
      }
    },
    unacknowledgeAgents: (paneKeys) =>
      set((s) => {
        if (paneKeys.length === 0) {
          return s
        }
        const ack = recordDraft(s.acknowledgedAgentsByPaneKey)
        const manual = recordDraft(s.manuallyUnreadTurnsByPaneKey)
        for (const key of paneKeys) {
          deleteChatReadMark(ack, 'acknowledgedAgentsByPaneKey', key)
          const turn = readManualUnreadProtectionTurn({ liveTurns: s.agentStatusByPaneKey }, key)
          const protection = turn ?? readWebChatMark(s, 'manuallyUnreadTurnsByPaneKey', key)
          deleteChatReadMarkAliases(manual, 'manuallyUnreadTurnsByPaneKey', key)
          if (protection !== undefined) {
            manual.set(key, protection)
          }
        }
        const nextAck = ack.finish()
        const nextManual = manual.finish()
        return nextAck === s.acknowledgedAgentsByPaneKey &&
          nextManual === s.manuallyUnreadTurnsByPaneKey
          ? s
          : { acknowledgedAgentsByPaneKey: nextAck, manuallyUnreadTurnsByPaneKey: nextManual }
      }),
    manuallyUnreadTurnsByPaneKey: {},
    clearManuallyUnreadTurns: (paneKeys) =>
      set((s) => {
        const manual = recordDraft(s.manuallyUnreadTurnsByPaneKey)
        for (const key of paneKeys) {
          deleteChatReadMark(manual, 'manuallyUnreadTurnsByPaneKey', key)
        }
        const next = manual.finish()
        return next === s.manuallyUnreadTurnsByPaneKey ? s : { manuallyUnreadTurnsByPaneKey: next }
      }),
    activityClearedAtByPaneKey: {},
    applyActivityClearedAt: (patch) =>
      set((s) => {
        const cleared = recordDraft(s.activityClearedAtByPaneKey)
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) {
            deleteChatReadMark(cleared, 'activityClearedAtByPaneKey', key)
          } else {
            deleteChatReadMarkAliases(cleared, 'activityClearedAtByPaneKey', key)
            cleared.set(key, value)
          }
        }
        const next = cleared.finish()
        return next === s.activityClearedAtByPaneKey ? s : { activityClearedAtByPaneKey: next }
      })
  }
}
