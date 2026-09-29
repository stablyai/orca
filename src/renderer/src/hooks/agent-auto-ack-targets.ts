import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { isStructuredTab } from '@/components/native-chat/structured-agent-session-tabs'
import type { Tab } from '../../../shared/tab-types'

export type AutoAckTabTarget = {
  tabId: string
  worktreeId: string | null
  /** Which adapter owns `tabId`: a terminal tab id, or a structured chat's unified tab id. */
  surfaceKind: 'terminal' | 'structured'
}

type AutoAckTargetState = {
  activeView: string
  activeTabId: string | null
  activeWorktreeId: string | null
  activeTabIdByWorktree: Record<string, string | null>
  getActiveTab: (worktreeId: string) => Tab | null
}

/**
 * The one surface a workspace has on screen right now.
 *
 * Why the unified tab wins: a visible chat replaces the terminal in its group, but the
 * workspace's terminal tab id keeps naming the terminal that was there before — acknowledging
 * that id would clear a hidden terminal's unread.
 */
function resolveWorkspaceAutoAckTarget(
  state: AutoAckTargetState,
  worktreeId: string,
  terminalTabId: string | null
): AutoAckTabTarget | null {
  const activeTab = state.getActiveTab(worktreeId)
  if (activeTab && isStructuredTab(activeTab)) {
    return { tabId: activeTab.id, worktreeId, surfaceKind: 'structured' }
  }
  return terminalTabId === null
    ? null
    : { tabId: terminalTabId, worktreeId, surfaceKind: 'terminal' }
}

/**
 * Surfaces whose visible content counts as "seen" right now, each paired with the worktree that
 * owns it.
 *
 * Why the floating workspace is gated on panel visibility rather than `activeView`: the panel is an
 * overlay that sits above every view and stays mounted while closed, and its active tab never
 * becomes the global `activeTabId` — so neither the view nor the tab id can stand in for "on screen".
 */
export function resolveAutoAckTabTargets(
  state: AutoAckTargetState,
  options: { floatingPanelVisible: boolean }
): AutoAckTabTarget[] {
  const targets: AutoAckTabTarget[] = []
  if (options.floatingPanelVisible) {
    const floating = resolveWorkspaceAutoAckTarget(
      state,
      FLOATING_TERMINAL_WORKTREE_ID,
      state.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? null
    )
    // The floating pane is on top when two worktrees claim the same tab ID.
    if (floating) {
      targets.push(floating)
    }
  }
  if (state.activeView !== 'terminal') {
    return targets
  }
  const active = state.activeWorktreeId
    ? resolveWorkspaceAutoAckTarget(state, state.activeWorktreeId, state.activeTabId)
    : state.activeTabId === null
      ? null
      : { tabId: state.activeTabId, worktreeId: null, surfaceKind: 'terminal' as const }
  if (active && !targets.some((target) => target.tabId === active.tabId)) {
    targets.push(active)
  }
  return targets
}
