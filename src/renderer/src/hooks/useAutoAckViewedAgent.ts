import { useEffect } from 'react'
import { useAppStore } from '@/store'

// Why: an agent row counts as "already seen" when the user is actually looking
// at the tab it lives on. Without this effect, ack only fires via an explicit
// click in the dashboard — which misses the common case where the user is
// already on the terminal tab when the agent finishes or blocks. That leaves
// the dashboard bolded for an event the user literally just watched happen.
//
// The effect subscribes directly to the store (not via React selectors) so it
// re-runs on EVERY status update or view change without amplifying re-renders
// up the component tree. It acks whenever:
//   - activeView is 'terminal' (the user isn't on Settings/Tasks), AND
//   - activeWorktreeId + activeTabId identify a live tab, AND
//   - at least one agentStatusByPaneKey entry has tabId === activeTabId AND
//     its paneKey is not yet acked at the current stateStartedAt.
//
// We ack ALL matching panes in one call (a tab can host split panes, each
// with its own paneKey) so acknowledgeAgents' identity-preserving guard
// collapses the no-op path.
export function useAutoAckViewedAgent(): void {
  useEffect(() => {
    const maybeAck = (): void => {
      const s = useAppStore.getState()
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
    // Why: store.subscribe fires on every state change — the callback is a
    // cheap guard + Object.entries walk bounded by live agents, so running it
    // universally is far simpler than wiring per-slice selectors. The
    // acknowledgeAgents identity guard filters out no-ops so spurious
    // re-renders don't cascade.
    const unsubscribe = useAppStore.subscribe(maybeAck)
    return unsubscribe
  }, [])
}
