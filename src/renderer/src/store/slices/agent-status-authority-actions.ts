import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import { rendererAgentStatusObservations } from '../../lib/renderer-agent-status-observations'
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
      const ownerPaneKey = resolveAgentPaneAuthorityKey(paneKey)
      const retiredPaneKeys = retireAgentPaneAuthorityAliases(paneKey)
      const retiredPaneKeySet = new Set(retiredPaneKeys)
      for (const key of retiredPaneKeys) {
        rendererAgentStatusObservations.forget(key)
      }
      let hadLive = false
      set((s) => {
        const retiredLivePaneKeys = retiredPaneKeys.filter((key) => key in s.agentStatusByPaneKey)
        hadLive = retiredLivePaneKeys.length > 0
        let nextRetentionSuppressedPaneKeys = removePaneKeys(
          s.retentionSuppressedPaneKeys,
          retiredPaneKeySet
        )
        if (
          retiredLivePaneKeys.length > 0 &&
          nextRetentionSuppressedPaneKeys === s.retentionSuppressedPaneKeys
        ) {
          nextRetentionSuppressedPaneKeys = { ...nextRetentionSuppressedPaneKeys }
        }
        for (const key of retiredLivePaneKeys) {
          nextRetentionSuppressedPaneKeys[key] = true
        }
        return {
          agentStatusByPaneKey: removePaneKeys(s.agentStatusByPaneKey, retiredPaneKeySet),
          runtimeAgentOrchestrationByPaneKey: removePaneKeys(
            s.runtimeAgentOrchestrationByPaneKey,
            retiredPaneKeySet
          ),
          retainedAgentsByPaneKey: removePaneKeys(s.retainedAgentsByPaneKey, retiredPaneKeySet),
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
          unreadTerminalPanes: removePaneKeys(s.unreadTerminalPanes, retiredPaneKeySet),
          unreadAgentCompletionPanes: removePaneKeys(
            s.unreadAgentCompletionPanes,
            retiredPaneKeySet
          ),
          lastTerminalInputAtByPaneKey: removePaneKeys(
            s.lastTerminalInputAtByPaneKey,
            retiredPaneKeySet
          ),
          cacheTimerByKey: removePaneKeys(s.cacheTimerByKey, retiredPaneKeySet),
          retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
          recentlyRetiredAgentStatusPaneKeys: boundRecentlyRetiredAgentStatusPaneKeys(
            s.recentlyRetiredAgentStatusPaneKeys,
            retiredPaneKeys
          ),
          agentStatusEpoch: hadLive ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: hadLive ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (hadLive) {
        freshness.scheduleDeferred()
      }
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.retirePaneAuthority?.(ownerPaneKey)
      }
    },

    // Why: the tombstone claims this pane is gone; a live PTY binding to it proves
    // otherwise. Lift the fence on that proof rather than on the next hook event —
    // a pane re-attached mid-turn or while idle emits no new-turn event, so a
    // turn-triggered revival leaves exactly the reported permanent suppression
    // (STA-4114). This deliberately does NOT restore the rows retirement dropped;
    // those are genuinely stale. It only re-opens the pane to future status.
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
      // Why: deliberately OUTSIDE the guard above, and not gated on having cleared
      // anything here. This map is not a mirror of main's — main fences panes the
      // renderer never hears about (retirePtyAgentLaunchAuthority on command-finished
      // and PTY exit calls the hook server directly, and nothing pushes that back), and
      // this map is per-window and non-persisted, so a renderer reload empties it while
      // main's survives. Gating the send on a local tombstone reintroduces STA-4114 for
      // exactly those panes. The send is idempotent and main refuses closed tabs itself.
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
      // Why: the moved row carries the observation stamped for its OLD key; renderer-authored
      // observations for the new key must sort after it, not race it.
      rendererAgentStatusObservations.forget(from)
      rendererAgentStatusObservations.rebind(to)
      const targetTabId = getTabIdFromPaneKey(to) ?? undefined
      const targetLeafId = getLeafIdFromPaneKey(to) ?? undefined
      set((s) => ({
        agentStatusByPaneKey: movePaneKeyedRecord(s.agentStatusByPaneKey, from, to, (entry) => ({
          ...entry,
          paneKey: to,
          tabId: targetTabId
        })),
        // Why: retention/sidebar consumers gate on the epoch; a moved live row is a
        // pane-key change they must observe, not a silent remap.
        ...(from in s.agentStatusByPaneKey
          ? { agentStatusEpoch: s.agentStatusEpoch + 1, sortEpoch: s.sortEpoch + 1 }
          : {}),
        runtimeAgentOrchestrationByPaneKey: movePaneKeyedRecord(
          s.runtimeAgentOrchestrationByPaneKey,
          from,
          to
        ),
        retainedAgentsByPaneKey: movePaneKeyedRecord(
          s.retainedAgentsByPaneKey,
          from,
          to,
          (retained) => ({
            ...retained,
            entry: { ...retained.entry, paneKey: to, tabId: targetTabId },
            tab: targetTabId ? { ...retained.tab, id: targetTabId } : retained.tab
          })
        ),
        sleepingAgentSessionsByPaneKey: movePaneKeyedRecord(
          s.sleepingAgentSessionsByPaneKey,
          from,
          to,
          (record) => ({ ...record, paneKey: to, tabId: targetTabId })
        ),
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
        manuallyUnreadTurnsByPaneKey: movePaneKeyedRecord(s.manuallyUnreadTurnsByPaneKey, from, to),
        paneForegroundAgentByPaneKey: movePaneKeyedRecord(s.paneForegroundAgentByPaneKey, from, to),
        unreadTerminalPanes: movePaneKeyedRecord(s.unreadTerminalPanes, from, to),
        unreadAgentCompletionPanes: movePaneKeyedRecord(s.unreadAgentCompletionPanes, from, to),
        lastTerminalInputAtByPaneKey: movePaneKeyedRecord(s.lastTerminalInputAtByPaneKey, from, to),
        cacheTimerByKey: movePaneKeyedRecord(s.cacheTimerByKey, from, to),
        retentionSuppressedPaneKeys: movePaneKeyedRecord(s.retentionSuppressedPaneKeys, from, to)
      }))
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
