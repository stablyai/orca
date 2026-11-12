import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import { rendererAgentStatusObservations } from '../../../lib/agent-status/evidence/renderer-agent-status-observations'
import {
  resolveAgentPaneAuthorityKey,
  retireAgentPaneAuthorityAliases,
  transferAgentPaneAuthorityAlias
} from './agent-pane-authority'
import {
  boundRecentlyRetiredAgentStatusPaneKeys,
  movePaneKeyedRecord,
  removePaneKeys
} from './agent-status-pane-keyed-records'
import {
  getLeafIdFromPaneKey,
  getTabIdFromPaneKey,
  isRecentlyClosedAgentStatusTab
} from './agent-status-pane-key-tab-binding'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/non-secure-context-uuid'
import {
  movePaneAttention,
  removePanesAttention
} from '../workspace-attention/subject-attention-transitions'
import { settleAttentionRemovedBy } from '../workspace-attention/attention-removal-follow-up'
import { replaceRecordEntries } from '../../keyed-record-transitions'

export function createAgentStatusAuthorityActions(
  runtime: AgentStatusRuntime
): Pick<
  AgentStatusSlice,
  | 'scheduleAgentStatusFreshness'
  | 'retireAgentPaneAuthority'
  | 'restoreAgentPaneAuthority'
  | 'transferAgentPaneAuthority'
> {
  const { get, set, freshness } = runtime
  return {
    scheduleAgentStatusFreshness: () => freshness.schedule(),

    retireAgentPaneAuthority: (paneKey, options) => {
      const retirementId = createBrowserUuid()
      const ownerPaneKey = resolveAgentPaneAuthorityKey(paneKey)
      const previousRetirement = get().recentlyRetiredAgentStatusPaneKeys[ownerPaneKey]
      const retiredPaneKeys = [
        ...new Set([
          ...retireAgentPaneAuthorityAliases(paneKey),
          ...Object.keys(get().recentlyRetiredAgentStatusPaneKeys).filter(
            (key) =>
              typeof previousRetirement === 'string' &&
              get().recentlyRetiredAgentStatusPaneKeys[key] === previousRetirement
          )
        ])
      ]
      const retiredPaneKeySet = new Set(retiredPaneKeys)
      for (const key of retiredPaneKeys) {
        rendererAgentStatusObservations.forget(key)
      }
      let hadLive = false
      settleAttentionRemovedBy(set, get, () =>
        set((s, changedPaneKeys) => {
          const retiredLivePaneKeys = retiredPaneKeys.filter((key) =>
            s.agentStatusByPaneKey.has(key)
          )
          for (const key of retiredLivePaneKeys) {
            changedPaneKeys.add(key)
          }
          hadLive = retiredLivePaneKeys.length > 0
          return {
            agentStatusByPaneKey: removePaneKeys(s.agentStatusByPaneKey, retiredPaneKeySet),
            agentConversationsByPaneKey: removePaneKeys(
              s.agentConversationsByPaneKey,
              retiredPaneKeySet
            ),
            runtimeAgentOrchestrationByPaneKey: removePaneKeys(
              s.runtimeAgentOrchestrationByPaneKey,
              retiredPaneKeySet
            ),
            sleepingAgentSessionsByPaneKey: options?.preserveSleepingAgentSession
              ? s.sleepingAgentSessionsByPaneKey
              : removePaneKeys(s.sleepingAgentSessionsByPaneKey, retiredPaneKeySet),
            agentLaunchConfigByPaneKey: removePaneKeys(
              s.agentLaunchConfigByPaneKey,
              retiredPaneKeySet
            ),
            acknowledgedAgentsByPaneKey: removePaneKeys(
              s.acknowledgedAgentsByPaneKey,
              retiredPaneKeySet
            ),
            activityClearedAtByPaneKey: removePaneKeys(
              s.activityClearedAtByPaneKey,
              retiredPaneKeySet
            ),
            manuallyUnreadTurnsByPaneKey: removePaneKeys(
              s.manuallyUnreadTurnsByPaneKey,
              retiredPaneKeySet
            ),
            paneForegroundAgentByPaneKey: removePaneKeys(
              s.paneForegroundAgentByPaneKey,
              retiredPaneKeySet
            ),
            ...removePanesAttention(s, retiredPaneKeySet),
            lastTerminalInputAtByPaneKey: removePaneKeys(
              s.lastTerminalInputAtByPaneKey,
              retiredPaneKeySet
            ),
            cacheTimerByKey: removePaneKeys(s.cacheTimerByKey, retiredPaneKeySet),
            recentlyRetiredAgentStatusPaneKeys: boundRecentlyRetiredAgentStatusPaneKeys(
              s.recentlyRetiredAgentStatusPaneKeys,
              retiredPaneKeys,
              s.recentlyRetiredAgentStatusPaneKeys[ownerPaneKey] === true ||
                isRecentlyClosedAgentStatusTab(
                  s.recentlyClosedAgentStatusTabIds,
                  getTabIdFromPaneKey(ownerPaneKey)
                )
                ? true
                : retirementId
            ),
            agentStatusEpoch: hadLive ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
            sortEpoch: hadLive ? s.sortEpoch + 1 : s.sortEpoch
          }
        })
      )
      if (hadLive) {
        freshness.scheduleDeferred()
      }
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.retirePaneAuthority?.(
          ownerPaneKey,
          get().recentlyRetiredAgentStatusPaneKeys[ownerPaneKey] === retirementId
            ? retirementId
            : undefined
        )
      }
    },

    // Live PTY binding disproves pane tombstone (STA-4114); revive future status without restoring stale rows. Waiting for a new hook turn permanently suppresses idle/mid-turn reattachments.
    restoreAgentPaneAuthority: (paneKey) => {
      const ownerPaneKey = resolveAgentPaneAuthorityKey(paneKey)
      // Why: a closed tab is a stronger, separate claim — re-attach must not undo it.
      if (
        isRecentlyClosedAgentStatusTab(
          get().recentlyClosedAgentStatusTabIds,
          getTabIdFromPaneKey(ownerPaneKey)
        )
      ) {
        return
      }
      set((s) => {
        const restorable = [paneKey, ownerPaneKey].filter(
          (key) => key in s.recentlyRetiredAgentStatusPaneKeys
        )
        if (restorable.length === 0) {
          return s
        }
        const next = { ...s.recentlyRetiredAgentStatusPaneKeys }
        for (const key of restorable) {
          delete next[key]
        }
        return { recentlyRetiredAgentStatusPaneKeys: next }
      })
      // Always send idempotent revival to main, even without local tombstone: main-only fences and renderer reloads make maps diverge. Main independently refuses closed tabs (STA-4114).
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.restorePaneAuthority?.(ownerPaneKey)
      }
    },
    transferAgentPaneAuthority: ({ fromPaneKey, toPaneKey, ptyId }) => {
      const transfer = transferAgentPaneAuthorityAlias({ fromPaneKey, toPaneKey, ptyId })
      if (!transfer || transfer.previousOwnerPaneKey === transfer.ownerPaneKey) {
        return
      }
      const from = transfer.previousOwnerPaneKey
      const to = transfer.ownerPaneKey
      // Moved row retains old-key observation; new-key renderer writes must sort after it.
      rendererAgentStatusObservations.forget(from)
      rendererAgentStatusObservations.rebind(to)
      const targetTabId = getTabIdFromPaneKey(to) ?? undefined
      const targetLeafId = getLeafIdFromPaneKey(to) ?? undefined
      set((s, changedPaneKeys) => {
        changedPaneKeys.add(from)
        changedPaneKeys.add(to)
        const sleepingSession = s.sleepingAgentSessionsByPaneKey[from]
        return {
          agentStatusByPaneKey: movePaneKeyedRecord(s.agentStatusByPaneKey, from, to, (entry) => ({
            ...entry,
            paneKey: to,
            tabId: targetTabId
          })),
          agentConversationsByPaneKey: movePaneKeyedRecord(
            s.agentConversationsByPaneKey,
            from,
            to,
            (identity) => ({ ...identity, paneKey: to })
          ),
          // Bump epoch on live pane-key moves so sidebar consumers observe the remap.
          ...(s.agentStatusByPaneKey.has(from)
            ? { agentStatusEpoch: s.agentStatusEpoch + 1, sortEpoch: s.sortEpoch + 1 }
            : {}),
          runtimeAgentOrchestrationByPaneKey: movePaneKeyedRecord(
            s.runtimeAgentOrchestrationByPaneKey,
            from,
            to
          ),
          sleepingAgentSessionsByPaneKey:
            sleepingSession === undefined
              ? s.sleepingAgentSessionsByPaneKey
              : replaceRecordEntries<SleepingAgentSessionRecord>(s.sleepingAgentSessionsByPaneKey, [
                  [from, null],
                  [to, { ...sleepingSession, paneKey: to, tabId: targetTabId }]
                ]),
          agentLaunchConfigByPaneKey: movePaneKeyedRecord(
            s.agentLaunchConfigByPaneKey,
            from,
            to,
            (entry) => ({
              ...entry,
              identity: { ...entry.identity, tabId: targetTabId, leafId: targetLeafId }
            })
          ),
          acknowledgedAgentsByPaneKey: movePaneKeyedRecord(s.acknowledgedAgentsByPaneKey, from, to),
          activityClearedAtByPaneKey: movePaneKeyedRecord(s.activityClearedAtByPaneKey, from, to),
          manuallyUnreadTurnsByPaneKey: movePaneKeyedRecord(
            s.manuallyUnreadTurnsByPaneKey,
            from,
            to
          ),
          paneForegroundAgentByPaneKey: movePaneKeyedRecord(
            s.paneForegroundAgentByPaneKey,
            from,
            to
          ),
          ...movePaneAttention(s, from, to),
          lastTerminalInputAtByPaneKey: movePaneKeyedRecord(
            s.lastTerminalInputAtByPaneKey,
            from,
            to
          ),
          cacheTimerByKey: movePaneKeyedRecord(s.cacheTimerByKey, from, to)
        }
      })
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.transferPaneAuthority?.({
          fromPaneKey: from,
          toPaneKey: to,
          ...(transfer.ptyId ? { ptyId: transfer.ptyId } : {})
        })
      }
    }
  }
}
