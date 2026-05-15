import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { TerminalLayoutSnapshot } from '../../../shared/types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'

function resolveActiveLeafId(
  state: { terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> },
  activeTabId: string
): string | null {
  const leafId = state.terminalLayoutsByTabId[activeTabId]?.activeLeafId ?? null
  return leafId && isTerminalLeafId(leafId) ? leafId : null
}

/**
 * Pure helper used by the hook below — exported so the regression test for
 * the codex-row-stays-bold race (docs/codex-agent-row-bold-stuck.md) can
 * exercise the decision against a real test store without needing a DOM.
 *
 * Returns the list of paneKeys that should be acked given the active tab and
 * exact active leaf. Split tabs can host multiple agent panes, so equality on
 * `${tabId}:${leafId}` is required; tab-prefix matching would mark siblings
 * read without ever displaying them.
 */
export function computeAutoAckTargets(
  state: {
    agentStatusByPaneKey: Record<string, AgentStatusEntry>
    retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
    acknowledgedAgentsByPaneKey: Record<string, number>
  },
  activeTabId: string,
  activeLeafId: string | null
): string[] {
  if (!activeLeafId || !isTerminalLeafId(activeLeafId)) {
    return []
  }
  const targetKey = makePaneKey(activeTabId, activeLeafId)
  const targets: string[] = []
  const liveEntry = state.agentStatusByPaneKey[targetKey]
  if (liveEntry) {
    const ackAt = state.acknowledgedAgentsByPaneKey[targetKey] ?? 0
    // Why: use stateStartedAt (not updatedAt) so tool/prompt pings within the
    // same state don't re-trigger ack work — keeping the comparison aligned
    // with WorktreeCardAgents' is-unvisited rule.
    if (ackAt < liveEntry.stateStartedAt) {
      targets.push(targetKey)
    }
  }
  const retained = state.retainedAgentsByPaneKey[targetKey]
  if (retained) {
    const ackAt = state.acknowledgedAgentsByPaneKey[targetKey] ?? 0
    if (ackAt < retained.entry.stateStartedAt) {
      targets.push(targetKey)
    }
  }
  return targets
}

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
// agentStatusByPaneKey, retainedAgentsByPaneKey, acknowledgedAgentsByPaneKey)
// have changed — so the Object.entries walk only runs for updates
// that could legitimately affect the ack decision.
//
// It acks whenever:
//   - activeView is 'terminal' (the user isn't on Settings/Tasks), AND
//   - activeTabId identifies a live tab, AND
//   - at least one agentStatusByPaneKey entry OR retainedAgentsByPaneKey
//     entry has paneKey prefixed by `${activeTabId}:` AND its
//     ackAt < stateStartedAt.
//
// Why both maps: the inline-agents list renders the union of live + retained
// rows (see useWorktreeAgentRows), so the ack scan must too. Without the
// retained walk, a `done` row whose live entry was torn down by the
// title-revert path (see pty-connection.ts:onAgentExited) migrates to the
// retained map carrying a fresh `done.stateStartedAt` and never gets
// auto-acked — leaving the inline row bold forever even while the user
// stares at the terminal. Codex hits this race reliably because its TUI
// reverts to a shell title within milliseconds of `Stop`.
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
    let lastRetained: unknown = undefined
    let lastAcknowledged: unknown = undefined
    let lastLayouts: unknown = undefined

    const maybeAck = (): void => {
      const s = useAppStore.getState()
      if (
        s.activeView === lastActiveView &&
        s.activeTabId === lastActiveTabId &&
        s.agentStatusByPaneKey === lastAgentStatus &&
        s.retainedAgentsByPaneKey === lastRetained &&
        s.acknowledgedAgentsByPaneKey === lastAcknowledged &&
        s.terminalLayoutsByTabId === lastLayouts
      ) {
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
      const activeLeafId = resolveActiveLeafId(s, activeTabId)
      // Why: advance the refs ONLY after all gates have passed — if the
      // visibility gate (window hidden/unfocused or no activeTabId) caused an
      // early return, leave the refs stale so the next call (e.g. triggered by
      // the focus listener on return) sees a diff and actually runs the scan.
      // Updating refs before the gates would consume the diff silently and
      // leave the user returning to cards whose bold-until-viewed rows stay
      // bold until some unrelated store change happens to bump the refs.
      lastActiveView = s.activeView
      lastActiveTabId = s.activeTabId
      lastAgentStatus = s.agentStatusByPaneKey
      lastRetained = s.retainedAgentsByPaneKey
      lastAcknowledged = s.acknowledgedAgentsByPaneKey
      lastLayouts = s.terminalLayoutsByTabId
      const toAck = computeAutoAckTargets(s, activeTabId, activeLeafId)
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
