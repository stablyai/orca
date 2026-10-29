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

export type AutoAckTabTarget = {
  tabId: string
  worktreeId: string | null
  /** Which adapter owns `tabId`: a terminal tab id, or a structured chat's unified tab id. */
  surfaceKind: 'terminal' | 'structured'
}

export type AutoAckTargetState = FloatingWorkspacePanelVisibilityState & {
  activeView: string
  activeWorktreeId: string | null
  layoutByWorktree?: Readonly<Record<string, TabGroupLayoutNode | undefined>>
  groupsByWorktree: Readonly<Record<string, readonly Pick<TabGroup, 'id' | 'activeTabId'>[]>>
  activeGroupIdByWorktree: Readonly<Record<string, string | null | undefined>>
  unifiedTabsByWorktree: Readonly<Record<string, readonly Tab[]>>
}

/** Collect visible split groups, focused first; unified selection wins because chat can replace a terminal whose legacy active ID still names hidden content. */
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

/** Pair on-screen targets with workspaces; floating-panel visibility owns its gate because it overlays every view and never becomes global activeTabId. */
export function resolveAutoAckTabTargets(state: AutoAckTargetState): AutoAckTabTarget[] {
  // The floating pane is on top when two worktrees claim the same tab ID.
  const targets = selectFloatingWorkspacePanelVisible(state)
    ? resolveWorkspaceAutoAckTargets(state, FLOATING_TERMINAL_WORKTREE_ID)
    : []
  if (state.activeView !== 'terminal' || !state.activeWorktreeId) {
    return targets
  }
  for (const target of resolveWorkspaceAutoAckTargets(state, state.activeWorktreeId)) {
    if (!targets.some((existing) => existing.tabId === target.tabId)) {
      targets.push(target)
    }
  }
  return targets
}

export function onScreenWorkspaceIds(state: AutoAckTargetState): string[] {
  const workspaceIds = selectFloatingWorkspacePanelVisible(state)
    ? [FLOATING_TERMINAL_WORKTREE_ID]
    : []
  if (state.activeView === 'terminal' && state.activeWorktreeId) {
    workspaceIds.push(state.activeWorktreeId)
  }
  return workspaceIds
}

export function isWorkspaceOnScreen(state: AutoAckTargetState, workspaceId: string): boolean {
  return (
    isOrcaWindowForegroundFocused() &&
    isPresenceConfirmed() &&
    onScreenWorkspaceIds(state).includes(workspaceId)
  )
}

/** Use the scan’s visibility/focus/presence gate so marking skips exactly the attention the scan would immediately acknowledge. */
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
