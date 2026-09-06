import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { SessionGridFilter } from '../../../shared/session-grid-types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { resolveActiveTabOwnerWorktreeId } from '@/store/slices/active-tab-owner-worktree'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'

/**
 * Who counts as "seen", and what a sighting clears. Pure over the state it is handed, so
 * every rule here is testable without the scan loop in `useAutoAckViewedAgent` that drives it.
 */

export function resolveActiveLeafId(
  state: { terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> },
  activeTabId: string
): string | null {
  const leafId = state.terminalLayoutsByTabId[activeTabId]?.activeLeafId ?? null
  return leafId && isTerminalLeafId(leafId) ? leafId : null
}

/**
 * Returns paneKeys to ack for the active tab/leaf; exported for the
 * codex-row-bold regression test (docs/codex-agent-row-bold-stuck.md).
 *
 * Why: split tabs host multiple agent panes, so match exact `${tabId}:${leafId}` — a tab-prefix match would ack undisplayed siblings.
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
    // Why: compare stateStartedAt (not updatedAt) so same-state pings don't re-trigger ack, matching WorktreeCardAgents' is-unvisited rule.
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

export function computeViewedAgentCompletionPaneKey(
  state: {
    unreadAgentCompletionPanes: Record<string, true>
  },
  activeTabId: string,
  activeLeafId: string | null
): string | null {
  if (!activeLeafId || !isTerminalLeafId(activeLeafId)) {
    return null
  }

  const targetKey = makePaneKey(activeTabId, activeLeafId)
  return state.unreadAgentCompletionPanes[targetKey] ? targetKey : null
}

export function getAgentTurnTimestamp(
  state: {
    agentStatusByPaneKey: Record<string, AgentStatusEntry>
    retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  },
  paneKey: string
): number | null {
  return (
    state.agentStatusByPaneKey[paneKey]?.stateStartedAt ??
    state.retainedAgentsByPaneKey[paneKey]?.entry.stateStartedAt ??
    null
  )
}

export function shouldClearViewedAgentWorktreeUnread(
  state: {
    tabsByWorktree: Record<string, { id: string }[]>
    unreadAgentCompletionPanes: Record<string, true>
    unreadTerminalTabs: Record<string, true>
  },
  args: {
    activeWorktreeId: string | null
    activeTabId: string
    paneKeysToClear: Set<string>
  }
): boolean {
  if (!args.activeWorktreeId) {
    return false
  }

  const tabIds = new Set((state.tabsByWorktree[args.activeWorktreeId] ?? []).map((tab) => tab.id))
  if (tabIds.size === 0) {
    return true
  }

  // Why: worktree unread is coarse — don't clear for the visible pane if a hidden tab/pane in the same worktree still owns unread attention.
  for (const paneKey of Object.keys(state.unreadAgentCompletionPanes)) {
    if (args.paneKeysToClear.has(paneKey)) {
      continue
    }
    const parsed = parsePaneKey(paneKey)
    if (parsed && tabIds.has(parsed.tabId)) {
      return false
    }
  }

  for (const tabId of Object.keys(state.unreadTerminalTabs)) {
    if (tabId !== args.activeTabId && tabIds.has(tabId)) {
      return false
    }
  }

  return true
}

/**
 * Manual mark-unread protections that no longer apply: the user moved to another pane, or the
 * agent took a new turn. Exported for the startup-race test.
 */
export function computeLapsedManualUnreadProtections(
  state: {
    agentStatusByPaneKey: Record<string, AgentStatusEntry>
    retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
    manuallyUnreadTurnsByPaneKey: Record<string, number>
  },
  activePaneKeys: ReadonlySet<string>
): string[] {
  const lapsed: string[] = []
  for (const [paneKey, turnTimestamp] of Object.entries(state.manuallyUnreadTurnsByPaneKey)) {
    if (!activePaneKeys.has(paneKey)) {
      lapsed.push(paneKey)
      continue
    }
    const currentTurn = getAgentTurnTimestamp(state, paneKey)
    // Why keep on null: persisted UI hydrates before the status snapshot lands, so an active
    // pane with no row yet is "not known", not "moved on"; wiping it would lose the mark-unread
    // the user made before relaunch.
    if (currentTurn !== null && currentTurn !== turnTimestamp) {
      lapsed.push(paneKey)
    }
  }
  return lapsed
}

type ViewedAgentAttentionActions = {
  acknowledgeAgents: (paneKeys: string[]) => void
  clearWorktreeUnread: (worktreeId: string) => void
  clearTerminalTabUnread: (tabId: string) => void
  clearTerminalPaneUnread: (paneKey: string) => void
}

export function acknowledgeViewedAgentAttention(
  state: ViewedAgentAttentionActions,
  args: {
    activeWorktreeId: string | null
    activeTabId: string
    paneKeys: string[]
    activePaneKey?: string | null
    /**
     * The tab's own bell (`unreadTerminalTabs`), which has no pane to ack. In the terminal
     * view the mounting TerminalPane clears it; a session-grid card shows a preview, not a
     * pane, so without this its bell would survive the click that acked its agent row.
     */
    hasTabUnread?: boolean
  }
): void {
  const paneKeysToClear = new Set(args.paneKeys)
  if (args.activePaneKey) {
    paneKeysToClear.add(args.activePaneKey)
  }

  if (args.paneKeys.length === 0 && paneKeysToClear.size === 0 && !args.hasTabUnread) {
    return
  }

  if (args.paneKeys.length > 0) {
    state.acknowledgeAgents(args.paneKeys)
  }
  if (args.activeWorktreeId) {
    // Why: the selected agent is now visible, so clear the Dock-driving worktree unread without a click.
    state.clearWorktreeUnread(args.activeWorktreeId)
  }
  state.clearTerminalTabUnread(args.activeTabId)
  for (const paneKey of paneKeysToClear) {
    state.clearTerminalPaneUnread(paneKey)
  }
}

export type AutoAckTabTarget = { tabId: string; worktreeId: string | null }

/**
 * The selected card as an ack target, or null when the grid is no longer showing it.
 *
 * Membership, not viewport: scroll position is deliberately not consulted (that was
 * considered and rejected), but a card the user hid, filtered away or closed is not one
 * the user is looking at — and acking it clears its signal on five surfaces for a turn
 * nobody saw. The state axis is not read here: it is the one axis a card can leave by
 * itself, and it does so by finishing its turn in front of the user.
 */
function sessionGridSelectionOnTheBoard(
  state: {
    activeWorktreeId: string | null
    sessionsGridFilter: SessionGridFilter
    sessionsGridHiddenTabIds: readonly string[]
    tabsByWorktree: Record<string, TerminalTab[]>
  },
  tabId: string
): AutoAckTabTarget | null {
  if (state.sessionsGridHiddenTabIds.includes(tabId)) {
    return null
  }
  // The card's own worktree, not the sidebar's selection: the grid lists every workspace.
  const worktreeId = resolveActiveTabOwnerWorktreeId(
    state.tabsByWorktree,
    state.activeWorktreeId,
    tabId
  )
  // Null means no open session owns the tab any more: it was closed out from under the pick.
  if (!worktreeId) {
    return null
  }
  // Why the length check: a filter naming a workspace with no open session is one the grid
  // itself drops (buildSessionGridListing), so honouring it here would suppress every ack.
  const filter = state.sessionsGridFilter
  if (filter !== 'all' && (state.tabsByWorktree[filter]?.length ?? 0) > 0) {
    return worktreeId === filter ? { tabId, worktreeId } : null
  }
  return { tabId, worktreeId }
}

/**
 * Tabs whose visible pane counts as "seen" right now, each paired with the worktree that owns it.
 *
 * Why the floating workspace is gated on panel visibility rather than `activeView`: the panel is an
 * overlay that sits above every view and stays mounted while closed, and its active tab never
 * becomes the global `activeTabId` — so neither the view nor the tab id can stand in for "on screen".
 */
export function resolveAutoAckTabTargets(
  state: {
    activeView: string
    activeTabId: string | null
    activeWorktreeId: string | null
    activeTabIdByWorktree: Record<string, string | null>
    activeSessionGridTabId: string | null
    sessionsGridFilter: SessionGridFilter
    sessionsGridHiddenTabIds: readonly string[]
    tabsByWorktree: Record<string, TerminalTab[]>
  },
  options: { floatingPanelVisible: boolean }
): AutoAckTabTarget[] {
  const targets: AutoAckTabTarget[] = []
  if (state.activeView === 'terminal' && state.activeTabId) {
    targets.push({ tabId: state.activeTabId, worktreeId: state.activeWorktreeId })
  }
  // Why the grid's selected card and not every card on screen: these maps are global —
  // sidebar, tab bar, Dock badge and Activity all read them — so counting "visible" as
  // "seen" would silence nine turns across five surfaces for agents the user merely
  // scrolled past. Selecting a card is the deliberate act; being in the viewport is not.
  if (state.activeView === 'sessions' && state.activeSessionGridTabId) {
    const tabId = state.activeSessionGridTabId
    const gridTarget = sessionGridSelectionOnTheBoard(state, tabId)
    if (gridTarget) {
      targets.push(gridTarget)
    }
  }
  if (options.floatingPanelVisible) {
    const floatingTabId = state.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? null
    // Why first-wins on a tab-id collision: tab ids can be claimed by two worktrees
    // (see active-tab-owner-worktree), and acking under the wrong one strands its unread dot.
    if (floatingTabId && !targets.some((target) => target.tabId === floatingTabId)) {
      targets.push({ tabId: floatingTabId, worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
    }
  }
  return targets
}
