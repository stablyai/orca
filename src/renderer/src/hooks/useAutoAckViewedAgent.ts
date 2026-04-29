import { useEffect } from 'react'
import { useAppStore } from '@/store'

// Why: an agent row counts as "already seen" when the user is actually looking
// at the tab it lives on. Without this effect, ack only fires via an explicit
// click in the dashboard — which misses the common case where the user is
// already on the terminal tab when the agent finishes or blocks. That leaves
// the dashboard bolded for an event the user literally just watched happen.
//
// The effect subscribes directly to the store (not via React selectors) so it
// sees every state change with no re-render amplification up the component
// tree. A reference-equality guard inside the callback bails out immediately
// when none of the four slices we care about (activeView, activeTabId,
// agentStatusByPaneKey, acknowledgedAgentsByPaneKey) have changed — so the
// Object.entries walk only runs for updates that could legitimately affect
// the ack decision.
//
// It acks whenever:
//   - activeView is 'terminal' (the user isn't on Settings/Tasks), AND
//   - activeTabId identifies a live tab, AND
//   - at least one agentStatusByPaneKey entry has paneKey prefixed by
//     `${activeTabId}:` AND its ackAt < stateStartedAt.
//
// We ack ALL matching panes in one call (a tab can host split panes, each
// with its own paneKey) so acknowledgeAgents' identity-preserving guard
// collapses the no-op path.
export function useAutoAckViewedAgent(): void {
  useEffect(() => {
    // Why: the root zustand store is created with plain `create()` (no
    // subscribeWithSelector middleware), so subscribe has no selector form.
    // Track the slice references we actually depend on and early-return on
    // unrelated updates — terminal output, tab state, settings, etc. would
    // otherwise invoke the scan on every store change. Initialize to
    // `undefined` so the first call always runs at least once.
    let lastActiveView: unknown = undefined
    let lastActiveTabId: unknown = undefined
    let lastAgentStatus: unknown = undefined
    let lastAcknowledged: unknown = undefined

    const maybeAck = (): void => {
      const s = useAppStore.getState()
      if (
        s.activeView === lastActiveView &&
        s.activeTabId === lastActiveTabId &&
        s.agentStatusByPaneKey === lastAgentStatus &&
        s.acknowledgedAgentsByPaneKey === lastAcknowledged
      ) {
        return
      }
      lastActiveView = s.activeView
      lastActiveTabId = s.activeTabId
      lastAgentStatus = s.agentStatusByPaneKey
      lastAcknowledged = s.acknowledgedAgentsByPaneKey

      if (s.activeView !== 'terminal') {
        return
      }
      const activeTabId = s.activeTabId
      if (!activeTabId) {
        return
      }
      const prefix = `${activeTabId}:`
      const toAck: string[] = []
      for (const [paneKey, entry] of Object.entries(s.agentStatusByPaneKey)) {
        if (!paneKey.startsWith(prefix)) {
          continue
        }
        const ackAt = s.acknowledgedAgentsByPaneKey[paneKey] ?? 0
        // Why: use stateStartedAt (not updatedAt) so tool/prompt pings
        // within the same state don't re-trigger ack work on every event —
        // acknowledgeAgents short-circuits anyway when the value is
        // unchanged, but keeping the comparison in sync with the
        // "is-unvisited" rule in DashboardWorktreeCard avoids a stutter
        // where we ack on an updatedAt-bump that didn't cross a state
        // transition.
        if (ackAt < entry.stateStartedAt) {
          toAck.push(paneKey)
        }
      }
      if (toAck.length > 0) {
        s.acknowledgeAgents(toAck)
      }
    }
    // Why: run once on mount to catch the case where the app restores to a
    // session whose current state already has agents on the visible tab.
    maybeAck()
    // Why: store.subscribe fires on every state change. The reference-
    // equality guard above bails out immediately for the common case
    // (terminal output, timers, etc.) so the Object.entries walk only runs
    // when one of the four slices we read has actually changed.
    const unsubscribe = useAppStore.subscribe(maybeAck)
    return unsubscribe
  }, [])
}
