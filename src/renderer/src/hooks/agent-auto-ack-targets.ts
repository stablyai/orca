import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { isOrcaWindowForegroundFocused } from '@/components/terminal-pane/terminal-notification-pane-visibility'
import { isStructuredTab } from '../../../shared/structured-agent-session-tab'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import { collectTabGroupLayoutGroupIds } from '../../../shared/workspace-layout/tab-group-moves'
import { isPresenceConfirmed } from './agent-auto-ack-presence'
import {
  selectFloatingWorkspacePanelVisible,
  type FloatingWorkspacePanelVisibilityState
} from '@/store/floating-workspace-panel-selector'
import {
  selectWorktreeSplitPartnerId,
  type WorktreeSplitViewPair
} from '@/store/slices/worktree-split-view'

export type AutoAckTabTarget = {
  tabId: string
  worktreeId: string | null
  /** Which adapter owns `tabId`: a terminal tab id, or a structured chat's unified tab id. */
  surfaceKind: 'terminal' | 'structured'
}

export type AutoAckTargetState = FloatingWorkspacePanelVisibilityState & {
  activeView: string
  activeWorktreeId: string | null
  worktreeSplitViewPair?: WorktreeSplitViewPair | null
  layoutByWorktree?: Readonly<Record<string, TabGroupLayoutNode | undefined>>
  groupsByWorktree: Readonly<Record<string, readonly Pick<TabGroup, 'id' | 'activeTabId'>[]>>
  activeGroupIdByWorktree: Readonly<Record<string, string | null | undefined>>
  unifiedTabsByWorktree: Readonly<Record<string, readonly Tab[]>>
}

/**
 * The tab each visible group of a workspace shows: every leaf of its split layout, the focused
 * group first, or the focused group alone before any split exists.
 *
 * Why the unified tab wins: a visible chat replaces the terminal in its group, but the
 * workspace's terminal tab id keeps naming the terminal that was there before — acknowledging
 * that id would clear a hidden terminal's unread.
 */
function resolveWorkspaceAutoAckTargets(
  state: AutoAckTargetState,
  worktreeId: string
): AutoAckTabTarget[] {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const focusedGroupId = state.activeGroupIdByWorktree[worktreeId] ?? groups[0]?.id
  const groupIds = new Set(focusedGroupId ? [focusedGroupId] : [])
  collectTabGroupLayoutGroupIds(state.layoutByWorktree?.[worktreeId], groupIds)
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const targets: AutoAckTabTarget[] = []
  for (const groupId of groupIds) {
    const activeTabId = groups.find((group) => group.id === groupId)?.activeTabId
    const tab = activeTabId ? tabs.find((candidate) => candidate.id === activeTabId) : undefined
    if (tab && isStructuredTab(tab)) {
      targets.push({ tabId: tab.id, worktreeId, surfaceKind: 'structured' })
    } else if (tab?.contentType === 'terminal') {
      targets.push({ tabId: tab.entityId, worktreeId, surfaceKind: 'terminal' })
    }
  }
  return targets
}

/** The active workspace and, in split view, the partner shown beside it. */
function terminalViewWorkspaceIds(state: AutoAckTargetState): string[] {
  if (state.activeView !== 'terminal' || !state.activeWorktreeId) {
    return []
  }
  const partnerId = selectWorktreeSplitPartnerId({
    activeWorktreeId: state.activeWorktreeId,
    worktreeSplitViewPair: state.worktreeSplitViewPair ?? null
  })
  return partnerId ? [state.activeWorktreeId, partnerId] : [state.activeWorktreeId]
}

/**
 * Surfaces whose visible content counts as "seen" right now, each paired with the worktree that
 * owns it.
 *
 * Why the floating workspace is gated on panel visibility rather than `activeView`: the panel is an
 * overlay that sits above every view and stays mounted while closed, and its active tab never
 * becomes the global `activeTabId` — so neither the view nor the tab id can stand in for "on screen".
 */
export function resolveAutoAckTabTargets(state: AutoAckTargetState): AutoAckTabTarget[] {
  // The floating pane is on top when two worktrees claim the same tab ID.
  const targets = selectFloatingWorkspacePanelVisible(state)
    ? resolveWorkspaceAutoAckTargets(state, FLOATING_TERMINAL_WORKTREE_ID)
    : []
  for (const worktreeId of terminalViewWorkspaceIds(state)) {
    for (const target of resolveWorkspaceAutoAckTargets(state, worktreeId)) {
      if (!targets.some((existing) => existing.tabId === target.tabId)) {
        targets.push(target)
      }
    }
  }
  return targets
}

/** The workspaces on screen: an open floating panel, and the terminal view's workspaces. */
export function onScreenWorkspaceIds(state: AutoAckTargetState): string[] {
  const workspaceIds = selectFloatingWorkspacePanelVisible(state)
    ? [FLOATING_TERMINAL_WORKTREE_ID]
    : []
  workspaceIds.push(...terminalViewWorkspaceIds(state))
  return workspaceIds
}

/** A workspace on screen in a visible, focused window with the user confirmed present. */
export function isWorkspaceOnScreen(state: AutoAckTargetState, workspaceId: string): boolean {
  return (
    isOrcaWindowForegroundFocused() &&
    isPresenceConfirmed() &&
    onScreenWorkspaceIds(state).includes(workspaceId)
  )
}

/**
 * Whether a tab of either kind is on screen in a visible, focused window with the user confirmed
 * present — the scan's own gate, so marking skips exactly what the scan would read right away.
 */
export function isTabOnScreen(
  state: AutoAckTargetState,
  worktreeId: string,
  tabId: string,
  surfaceKind: AutoAckTabTarget['surfaceKind']
): boolean {
  return (
    isOrcaWindowForegroundFocused() &&
    isPresenceConfirmed() &&
    resolveAutoAckTabTargets(state).some(
      (target) =>
        target.surfaceKind === surfaceKind &&
        target.tabId === tabId &&
        target.worktreeId === worktreeId
    )
  )
}
