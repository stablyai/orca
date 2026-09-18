import type { SessionGridFilter } from '../../../shared/session-grid-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

export type AutoAckTabTarget = { tabId: string; worktreeId: string | null }

function sessionGridSelectionOnTheBoard(
  state: {
    activeSessionGridWorktreeId?: string | null
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
  // A removed card cannot transfer its acknowledgement to another workspace's duplicate.
  let worktreeId = state.activeSessionGridWorktreeId
  if (worktreeId == null) {
    const owners = Object.keys(state.tabsByWorktree).filter((id) =>
      state.tabsByWorktree[id].some((tab) => tab.id === tabId)
    )
    if (owners.length !== 1) {
      return null
    }
    worktreeId = owners[0]
  }
  if (!worktreeId || !state.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)) {
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
    activeSessionGridWorktreeId?: string | null
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
  if (options.floatingPanelVisible) {
    const floatingTabId = state.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? null
    // The floating pane is on top when two worktrees claim the same tab ID.
    if (floatingTabId) {
      targets.push({ tabId: floatingTabId, worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
    }
  }
  if (
    state.activeView === 'terminal' &&
    state.activeTabId &&
    !targets.some((target) => target.tabId === state.activeTabId)
  ) {
    targets.push({ tabId: state.activeTabId, worktreeId: state.activeWorktreeId })
  }
  if (state.activeView === 'sessions' && state.activeSessionGridTabId) {
    const gridTarget = sessionGridSelectionOnTheBoard(state, state.activeSessionGridTabId)
    if (gridTarget && !targets.some((target) => target.tabId === gridTarget.tabId)) {
      targets.push(gridTarget)
    }
  }
  return targets
}
