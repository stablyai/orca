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
// when none of the five slices we care about (activeView, activeTabId,
// agentStatusByPaneKey, acknowledgedAgentsByPaneKey, settings) have changed —
// so the Object.entries walk only runs for updates that could legitimately
// affect the ack decision.
//
// It acks whenever:
//   - activeView is 'terminal' (the user isn't on Settings/Tasks), AND
//   - activeTabId identifies a live tab, AND
//   - at least one agentStatusByPaneKey entry has paneKey prefixed by
//     `${activeTabId}:` AND its ackAt < stateStartedAt.
//
// The ack ALSO requires the OS window to be visible and focused
// (document.visibilityState === 'visible' && document.hasFocus()) —
// otherwise a transition that arrives while the user is away would silently
// clear the bold-until-viewed signal for an event they never saw. A
// visibilitychange / focus listener re-runs the scan when the user returns
// so any transitions that failed the gate while away get acked the moment
// focus actually comes back.
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
    // Why: settings is tracked so flipping `experimentalAgentDashboard`
    // alone re-evaluates the feature gate below — without this, a pure
    // settings change would be swallowed by the fast-path until some other
    // tracked slice changed. Tracking the whole settings reference (rather
    // than the one specific boolean) is acceptable because settings changes
    // are rare compared to agent-status updates, and it matches the existing
    // pattern of tracking whole slice references.
    let lastSettings: unknown = undefined

    const maybeAck = (): void => {
      const s = useAppStore.getState()
      if (
        s.activeView === lastActiveView &&
        s.activeTabId === lastActiveTabId &&
        s.agentStatusByPaneKey === lastAgentStatus &&
        s.acknowledgedAgentsByPaneKey === lastAcknowledged &&
        s.settings === lastSettings
      ) {
        return
      }

      // Why: mirror the inline agents' visibility gate — when the
      // experimental agent-activity feature is off, nothing in the UI reads
      // the ack map, so accumulating entries for unseen agents is wasted
      // memory and the Object.entries scan below is pure overhead. The
      // subscribe callback fires on any store change, so flipping the
      // setting naturally re-evaluates this guard without a separate
      // subscription.
      if (s.settings?.experimentalAgentDashboard !== true) {
        return
      }

      if (s.activeView !== 'terminal') {
        return
      }
      // Why: the auto-ack represents "the user saw this row" — but tab-active is
      // only a proxy. If the OS window is hidden, minimized, or another app has
      // focus, the user is demonstrably not looking at the inline agents list
      // even with the terminal tab set. Without this gate, an agent finishing
      // while the user is away silently clears the bold-until-viewed signal and
      // the user returns to a card with no indication anything transitioned.
      if (typeof document !== 'undefined') {
        if (document.visibilityState !== 'visible') {
          return
        }
        if (!document.hasFocus()) {
          return
        }
      }
      const activeTabId = s.activeTabId
      if (!activeTabId) {
        return
      }
      // Why: advance the refs ONLY after all gates have passed — if the visibility
      // or feature gate caused an early return, we must leave the refs stale so
      // the next call (e.g. triggered by the focus listener on return) sees a
      // diff and actually runs the scan. Updating refs before the gates would
      // consume the diff silently and leave the user returning to cards whose
      // bold-until-viewed rows stay bold until some unrelated store change
      // happens to bump the refs again.
      lastActiveView = s.activeView
      lastActiveTabId = s.activeTabId
      lastAgentStatus = s.agentStatusByPaneKey
      lastAcknowledged = s.acknowledgedAgentsByPaneKey
      lastSettings = s.settings
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
        // "is-unvisited" rule in WorktreeCardAgents avoids a stutter
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
    // when one of the five slices we read has actually changed.
    const unsubscribe = useAppStore.subscribe(maybeAck)
    // Why: focus/visibility don't flow through the zustand store, so a
    // late-arriving transition that failed the gate above never re-evaluates
    // when focus returns. Subscribe to the two DOM events so the ack scan
    // reruns the moment the user is actually back on the window.
    const onVisibility = (): void => maybeAck()
    const onFocus = (): void => maybeAck()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [])
}
