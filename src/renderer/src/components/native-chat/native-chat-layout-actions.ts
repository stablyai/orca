import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import {
  resolveTabPaneColumnMoveTarget,
  moveTabToNewPaneColumn
} from '@/components/tab-bar/tab-move-to-pane-column'
import { requestActiveTerminalPaneSplit } from '@/components/tab-bar/request-active-terminal-pane-split'
import type { NativeChatSplitDirection } from './native-chat-split-shortcut'

export type NativeChatSplitTarget =
  | { kind: 'terminal-pane'; terminalTabId: string }
  | { kind: 'workspace-tab'; unifiedTabId: string; groupId: string }

export function resolveActiveNativeChatSplitTarget(
  state: Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  worktreeId: string | null,
  groupId: string | null
): NativeChatSplitTarget | null {
  if (!worktreeId || !groupId) {
    return null
  }
  const group = (state.groupsByWorktree?.[worktreeId] ?? []).find((entry) => entry.id === groupId)
  const tab = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
    (entry) => entry.id === group?.activeTabId && entry.groupId === groupId
  )
  if (tab?.contentType === 'agent-session') {
    return { kind: 'workspace-tab', unifiedTabId: tab.id, groupId }
  }
  if (tab?.contentType === 'terminal' && tab.viewMode === 'chat') {
    return { kind: 'terminal-pane', terminalTabId: tab.entityId }
  }
  return null
}

export function canRunNativeChatSplitTarget(
  state: Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  target: NativeChatSplitTarget | null
): boolean {
  if (!target) {
    return false
  }
  return (
    target.kind === 'terminal-pane' ||
    resolveTabPaneColumnMoveTarget(state, target.unifiedTabId, target.groupId) !== null
  )
}

export function runNativeChatSplitTarget(
  target: NativeChatSplitTarget,
  direction: NativeChatSplitDirection
): boolean {
  if (target.kind === 'terminal-pane') {
    requestActiveTerminalPaneSplit({
      tabId: target.terminalTabId,
      direction: direction === 'right' ? 'vertical' : 'horizontal'
    })
    return true
  }
  const moveTarget = resolveTabPaneColumnMoveTarget(
    useAppStore.getState(),
    target.unifiedTabId,
    target.groupId
  )
  return moveTarget ? moveTabToNewPaneColumn({ target: moveTarget, direction }) : false
}

export function runActiveNativeChatSplit(
  worktreeId: string | null,
  groupId: string | null,
  direction: NativeChatSplitDirection
): boolean {
  const state = useAppStore.getState()
  const target = resolveActiveNativeChatSplitTarget(state, worktreeId, groupId)
  return target ? runNativeChatSplitTarget(target, direction) : false
}
