import type { KeybindingContext } from '../../../../../shared/keybindings/types'
import {
  toVisibleTabType,
  type Tab
} from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { useAppStore } from '@/store/index'
import {
  guardPinnedTabClose,
  resolvePinnedTabLabel
} from '@/store/slices/tabs/closing/pinned-tab-close-guard'
import { createWorkspaceTabCloseCommands } from '@/lib/workspace/tabs/close/workspace-tab-close-commands'
import { hasUnsentBrowserNotes } from '@/store/slices/browser/annotations/browser-page-annotation'
import { captureWorkspaceEmptiedReaction } from '@/lib/workspace/tabs/close/workspace-emptied-reaction'
import {
  handleSwitchRecentTab,
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from '@/lib/workspace/tabs/ipc-tab-switch'
import { selectEmptyFloatingWorkspacePanelVisible } from '@/store/workspaces/floating/floating-workspace-panel-selector'
import { findFocusedSplitLandingGroup } from '@/store/slices/tabs/split-landing-groups'
import {
  isFloatingWorkspacePanelFocused,
  switchFloatingWorkspaceRecentTab,
  switchFloatingWorkspaceTab
} from '../../../components/floating-terminal/workspace/floating-workspace-terminal-actions'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '../../../components/floating-terminal/workspace/floating-workspace-open-intent'
import { closeWorkspaceBrowserTab } from '../../browser/workspace/workspace-browser-tab-close'
import { resolveBrowserWorkspaceOwner } from '../../browser/workspace/browser-workspace-source-resolution'
import { getActiveTabNavOrder } from '@/lib/workspace/tabs/order/group-tab-order'
import { reorderTabInGroup } from '@/runtime/workspace-layout/commands/tab-group-layout-owner-commands'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'

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
      floatingPanelGuestOwned?: boolean
    }
  | {
      type: 'switch'
      direction: number
      scope: 'same-type' | 'all-types' | 'terminal'
      floatingPanelOwned?: boolean
    }
  | { type: 'previous-recent'; floatingPanelOwned?: boolean }
  | { type: 'move'; direction: -1 | 1; floatingPanelOwned?: boolean }

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

// A split landing has no tab to close, so Close collapses the pane.
function closeFocusedSplitLanding(state: TabState): boolean {
  const group = findFocusedSplitLandingGroup(state, state.activeWorktreeId)
  if (group === null) {
    return false
  }
  // Closing a sole chooser empties the workspace, which then lands like a last-tab close.
  const whenEmptied = captureWorkspaceEmptiedReaction(group.worktreeId)
  if (!state.closeEmptyGroup(group.worktreeId, group.id)) {
    return false
  }
  whenEmptied()
  return true
}

/** Move the focused group's active tab past its visible neighbor; moves stop at the group's edges. */
export function moveActiveTab(worktreeId: string | null, direction: -1 | 1): boolean {
  if (!worktreeId) {
    return false
  }
  const state = useAppStore.getState()
  const groupId = state.activeGroupIdByWorktree[worktreeId]
  const group = (state.groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === groupId
  )
  const tabId = group?.activeTabId
  if (!group || !tabId) {
    return false
  }
  // Step past visible neighbors only, so a stale order entry never swallows the move.
  const visibleTabIds = getActiveTabNavOrder(state, worktreeId).map((ref) => ref.tabId)
  const index = visibleTabIds.indexOf(tabId)
  const neighborId = index === -1 ? undefined : visibleTabIds[index + direction]
  if (!neighborId || !group.tabOrder.includes(neighborId)) {
    return false
  }
  const tabOrder = group.tabOrder.filter((id) => id !== tabId)
  tabOrder.splice(tabOrder.indexOf(neighborId) + (direction === 1 ? 1 : 0), 0, tabId)
  reorderTabInGroup(worktreeId, { kind: 'reorder', tabId, groupId: group.id, tabOrder })
  return true
}

/** Input adapters describe intent; targeting and tab operations live here. */
export function dispatchWorkspaceTabCommand(command: WorkspaceTabCommand): boolean {
  const state = useAppStore.getState()
  if (command.type === 'close') {
    if (!command.target) {
      if (selectEmptyFloatingWorkspacePanelVisible(state)) {
        window.dispatchEvent(new Event(TOGGLE_FLOATING_TERMINAL_EVENT))
        return true
      }
      if (isFloatingWorkspacePanelFocused()) {
        return false
      }
      if (closeFocusedSplitLanding(state)) {
        return true
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
      const whenEmptied = captureWorkspaceEmptiedReaction(target.worktreeId)
      const plan = closeWorkspaceBrowserTab(target.worktreeId, target.browserWorkspaceId)
      if (
        plan.closesLocally &&
        plan.localCloseReason !== 'cleanup' &&
        !command.skipEmptyCheck &&
        !command.bulk
      ) {
        whenEmptied()
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
    const unsentNotes = tab.contentType === 'browser' && hasUnsentBrowserNotes(state, tab.entityId)
    // Bulk closes keep a tab holding unsent notes open, as they keep pinned tabs.
    if (command.bulk && unsentNotes) {
      return true
    }
    // Why before the pin guard: its prompt takes focus, and the floating panel's reaction reads focus.
    const whenEmptied =
      command.bulk || command.skipEmptyCheck
        ? undefined
        : captureWorkspaceEmptiedReaction(target.worktreeId, {
            floatingPanelGuestOwned: command.floatingPanelGuestOwned
          })
    const close = () =>
      commands.closeItem(tab.id, { whenEmptied, skipRunningProcessConfirm: command.bulk })
    if (tab.contentType === 'terminal' || command.bulk) {
      close()
    } else {
      guardPinnedTabClose({
        isPinned: tab.isPinned === true,
        tabLabel: resolvePinnedTabLabel(state, target.worktreeId, tab.id),
        onClose: close,
        unsentNotes
      })
    }
    return true
  }
  if (command.type === 'previous-recent') {
    if (command.floatingPanelOwned || isFloatingWorkspacePanelFocused()) {
      return switchFloatingWorkspaceRecentTab(state)
    }
    return handleSwitchRecentTab()
  }
  if (command.type === 'move') {
    const floatingPanelOwned = command.floatingPanelOwned || isFloatingWorkspacePanelFocused()
    return moveActiveTab(
      floatingPanelOwned ? FLOATING_TERMINAL_WORKTREE_ID : state.activeWorktreeId,
      command.direction
    )
  }
  if (command.floatingPanelOwned || isFloatingWorkspacePanelFocused()) {
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
