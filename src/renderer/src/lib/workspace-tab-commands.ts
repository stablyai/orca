import type { KeybindingContext } from '../../../shared/keybindings'
import { toVisibleTabType, type Tab } from '../../../shared/tab-types'
import { useAppStore } from '@/store'
import { guardPinnedTabClose, resolvePinnedTabLabel } from '@/store/pinned-tab-close-guard'
import { createWorkspaceTabCloseCommands } from '@/components/tab-group/workspace-tab-close-commands'
import {
  handleSwitchRecentTab,
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from '@/hooks/ipc-tab-switch'
import {
  isEmptyFloatingWorkspacePanelVisible,
  isFloatingWorkspacePanelFocused,
  switchFloatingWorkspaceTab
} from './floating-workspace-terminal-actions'
import { moveFloatingWorkspaceTab } from './floating-workspace-tab-reorder'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from './floating-terminal'
import { closeWorkspaceBrowserTab } from './workspace-browser-tab-close'
import { resolveBrowserWorkspaceOwner } from './browser-workspace-source-resolution'
import {
  getActiveTabNavOrder,
  moveTabIdWithinGroupOrder
} from '@/components/tab-bar/group-tab-order'
import { mirrorWebRuntimeTabMove } from '@/components/tab-bar/web-runtime-tab-move-mirror'

export type WorkspaceTabTarget =
  | { kind: 'tab'; worktreeId: string; tabId: string }
  | { kind: 'browser-source'; sourceId: string }

export type WorkspaceTabCommand =
  | {
      type: 'close'
      target?: WorkspaceTabTarget
      context?: KeybindingContext
      skipEmptyCheck?: boolean
      bulk?: boolean
    }
  | { type: 'switch'; direction: number; scope: 'same-type' | 'all-types' | 'terminal' }
  | { type: 'move-active'; direction: -1 | 1; target?: WorkspaceTabTarget }
  | { type: 'previous-recent' }

type TabState = ReturnType<typeof useAppStore.getState>

function hasFocusedGroup(state: TabState, worktreeId: string): boolean {
  const groupId = state.activeGroupIdByWorktree?.[worktreeId]
  return (state.groupsByWorktree?.[worktreeId] ?? []).some((group) => group.id === groupId)
}

function resolveActiveTab(state: TabState, worktreeId: string): Tab | null {
  const activeTab = state.getActiveTab(worktreeId)
  if (activeTab) {
    return activeTab
  }
  if (hasFocusedGroup(state, worktreeId)) {
    return null
  }
  // Hydration can publish the backing selection before its group selection.
  const entityId =
    state.activeTabType === 'browser'
      ? state.activeBrowserTabId
      : state.activeTabType === 'editor'
        ? state.activeFileId
        : state.activeTabId
  return (
    (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) =>
        toVisibleTabType(tab.contentType) === state.activeTabType && tab.entityId === entityId
    ) ?? null
  )
}

function resolveCloseTarget(
  state: TabState,
  target?: WorkspaceTabTarget
): { worktreeId: string; tab: Tab | null; browserWorkspaceId?: string } | null {
  if (target?.kind === 'tab') {
    const tab = (state.unifiedTabsByWorktree[target.worktreeId] ?? []).find(
      (tab) => tab.id === target.tabId
    )
    return tab ? { worktreeId: target.worktreeId, tab } : null
  }
  if (target?.kind === 'browser-source') {
    const owner = resolveBrowserWorkspaceOwner(state, target.sourceId)
    if (!owner) {
      return null
    }
    const tab = (state.unifiedTabsByWorktree[owner.worktreeId] ?? []).find(
      (tab) => tab.contentType === 'browser' && tab.entityId === owner.workspaceId
    )
    return { worktreeId: owner.worktreeId, tab: tab ?? null, browserWorkspaceId: owner.workspaceId }
  }
  if (!state.activeWorktreeId) {
    return null
  }
  const tab = resolveActiveTab(state, state.activeWorktreeId)
  if (tab) {
    return { worktreeId: state.activeWorktreeId, tab }
  }
  if (
    !hasFocusedGroup(state, state.activeWorktreeId) &&
    state.activeTabType === 'browser' &&
    state.activeBrowserTabId
  ) {
    return resolveCloseTarget(state, { kind: 'browser-source', sourceId: state.activeBrowserTabId })
  }
  return null
}

function resolveMoveTarget(
  state: TabState,
  target?: WorkspaceTabTarget
): { worktreeId: string; tab: Tab } | null {
  if (target?.kind === 'tab') {
    const tab = (state.unifiedTabsByWorktree[target.worktreeId] ?? []).find(
      (candidate) => candidate.id === target.tabId
    )
    return tab ? { worktreeId: target.worktreeId, tab } : null
  }
  if (target?.kind === 'browser-source') {
    const owner = resolveBrowserWorkspaceOwner(state, target.sourceId)
    if (!owner) {
      return null
    }
    const tab = (state.unifiedTabsByWorktree[owner.worktreeId] ?? []).find(
      (candidate) => candidate.contentType === 'browser' && candidate.entityId === owner.workspaceId
    )
    return tab ? { worktreeId: owner.worktreeId, tab } : null
  }
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return null
  }
  const groupId = state.activeGroupIdByWorktree[worktreeId]
  const group = groupId
    ? (state.groupsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === groupId)
    : undefined
  if (!group?.activeTabId) {
    return null
  }
  const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === group.activeTabId
  )
  return tab ? { worktreeId, tab } : null
}

function moveActiveWorkspaceTab(
  state: TabState,
  direction: -1 | 1,
  target?: WorkspaceTabTarget
): boolean {
  const resolved = resolveMoveTarget(state, target)
  if (!resolved) {
    return false
  }
  const { worktreeId, tab } = resolved
  const group = (state.groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === tab.groupId
  )
  if (!group) {
    return false
  }
  const visibleTabIds = getActiveTabNavOrder(state, worktreeId, {}, group.id).flatMap((tab) =>
    tab.tabId ? [tab.tabId] : []
  )
  const nextOrder = moveTabIdWithinGroupOrder(group.tabOrder, visibleTabIds, tab.id, direction)
  if (!nextOrder) {
    return false
  }
  state.reorderUnifiedTabs(group.id, nextOrder)
  mirrorWebRuntimeTabMove({
    kind: 'reorder',
    worktreeId,
    tabId: tab.id,
    targetGroupId: group.id,
    tabOrder: nextOrder
  })
  return true
}

/** Input adapters describe intent; targeting and tab operations live here. */
export function dispatchWorkspaceTabCommand(command: WorkspaceTabCommand): boolean {
  const state = useAppStore.getState()
  if (command.type === 'close') {
    if (!command.target) {
      if (isEmptyFloatingWorkspacePanelVisible()) {
        window.dispatchEvent(new Event(TOGGLE_FLOATING_TERMINAL_EVENT))
        return true
      }
      if (isFloatingWorkspacePanelFocused()) {
        return false
      }
    }
    const target = resolveCloseTarget(state, command.target)
    if (!target) {
      return false
    }
    if (!target.tab) {
      if (!target.browserWorkspaceId) {
        return false
      }
      const plan = closeWorkspaceBrowserTab(target.worktreeId, target.browserWorkspaceId)
      if (
        plan.closesLocally &&
        plan.localCloseReason !== 'cleanup' &&
        !command.skipEmptyCheck &&
        !command.bulk
      ) {
        createWorkspaceTabCloseCommands({
          worktreeId: target.worktreeId,
          groupTabs: []
        }).leaveWorktreeIfEmpty()
      }
      return true
    }
    const tab = target.tab
    if (command.context === 'terminal' && tab.contentType === 'terminal') {
      return false
    }
    const commands = createWorkspaceTabCloseCommands({
      worktreeId: target.worktreeId,
      groupTabs: state.unifiedTabsByWorktree[target.worktreeId] ?? []
    })
    if ((command.bulk || command.skipEmptyCheck) && tab.isPinned) {
      return true
    }
    const close = () =>
      commands.closeItem(tab.id, {
        skipEmptyCheck: command.bulk || command.skipEmptyCheck,
        skipRunningProcessConfirm: command.bulk
      })
    if (tab.contentType === 'terminal' || command.bulk) {
      close()
    } else {
      guardPinnedTabClose({
        isPinned: tab.isPinned === true,
        tabLabel: resolvePinnedTabLabel(state, target.worktreeId, tab.id),
        onClose: close
      })
    }
    return true
  }
  if (command.type === 'previous-recent') {
    if (isFloatingWorkspacePanelFocused()) {
      return false
    }
    return handleSwitchRecentTab()
  }
  if (command.type === 'move-active') {
    if (isFloatingWorkspacePanelFocused() && !command.target) {
      return moveFloatingWorkspaceTab(state, command.direction)
    }
    return moveActiveWorkspaceTab(state, command.direction, command.target)
  }
  if (isFloatingWorkspacePanelFocused()) {
    switchFloatingWorkspaceTab(state, command.direction, command.scope)
    return true
  }
  switch (command.scope) {
    case 'same-type':
      return handleSwitchTab(command.direction)
    case 'all-types':
      return handleSwitchTabAcrossAllTypes(command.direction)
    case 'terminal':
      return handleSwitchTerminalTab(command.direction)
  }
}
