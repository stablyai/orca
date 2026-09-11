import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

export type AutoAckTabTarget = { tabId: string; worktreeId: string | null }

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
  return targets
}
