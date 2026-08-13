import {
  getKeybindingDefinition,
  isKeybindingAllowedInTerminal,
  isKeybindingPotentialTerminalConflict,
  type KeybindingActionId
} from './keybindings'
import type { WindowShortcutAction } from './window-shortcut-policy'

/**
 * Maps a resolved window shortcut action to its keybinding id, or null when unmapped.
 * Split out of window-shortcut-policy.ts (input -> action) to stay under its line budget.
 */
export function getWindowShortcutActionId(action: WindowShortcutAction): KeybindingActionId | null {
  switch (action.type) {
    case 'zoom':
      return action.direction === 'in'
        ? 'zoom.in'
        : action.direction === 'out'
          ? 'zoom.out'
          : 'zoom.reset'
    case 'openSettings':
      return 'app.settings'
    case 'forceReload':
      return 'app.forceReload'
    case 'toggleWorktreePalette':
      return 'worktree.palette'
    case 'toggleFloatingTerminal':
      return 'floatingTerminal.toggle'
    case 'toggleLeftSidebar':
      return 'sidebar.left.toggle'
    case 'toggleRightSidebar':
      return 'sidebar.right.toggle'
    case 'openQuickOpen':
      return 'worktree.quickOpen'
    case 'toggleQuickCommandsMenu':
      return 'tab.openQuickCommandsMenu'
    case 'openNewWorkspace':
      return 'workspace.create'
    case 'deleteCurrentWorkspace':
      return 'workspace.delete'
    case 'openWorkspaceBoard':
      return 'workspace.openBoard'
    case 'openTasks':
      return 'view.tasks'
    case 'switchRecentTab':
      return 'tab.previousRecent'
    case 'worktreeHistoryNavigate':
      return action.direction === 'back' ? 'worktree.history.back' : 'worktree.history.forward'
    case 'dictationKeyDown':
      return 'voice.dictation'
    case 'jumpToWorktreeIndex':
      return 'workspace.selectByIndex'
    case 'jumpToTabIndex':
      return 'tab.selectByIndex'
    case 'switchProviderAccountIndex':
      return `accounts.${action.provider}.selectByIndex`
  }
}

/** Whether the action's keybinding should be captured from terminal guests instead of forwarded to them. */
export function windowShortcutActionCapturesTerminal(action: WindowShortcutAction): boolean {
  const actionId = getWindowShortcutActionId(action)
  if (!actionId) {
    return false
  }
  const definition = getKeybindingDefinition(actionId)
  if (!definition || isKeybindingAllowedInTerminal(definition)) {
    return false
  }
  return isKeybindingPotentialTerminalConflict(definition)
}
