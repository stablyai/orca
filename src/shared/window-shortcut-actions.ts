import type { KeybindingActionId } from './keybindings'

export type WindowShortcutAction =
  | { type: 'zoom'; direction: 'in' | 'out' | 'reset' }
  | { type: 'openSettings' }
  | { type: 'forceReload' }
  | { type: 'toggleWorktreePalette' }
  | { type: 'toggleFloatingTerminal' }
  | { type: 'toggleLeftSidebar' }
  | { type: 'toggleRightSidebar' }
  | { type: 'openQuickOpen' }
  | { type: 'toggleQuickCommandsMenu' }
  | { type: 'openNewWorkspace' }
  | { type: 'deleteCurrentWorkspace' }
  | { type: 'openWorkspaceBoard' }
  | { type: 'openTasks' }
  | { type: 'toggleAgentDashboard' }
  | { type: 'switchRecentTab' }
  | { type: 'focusTabGroup'; direction: 1 | -1 }
  | { type: 'jumpToWorktreeIndex'; index: number }
  | { type: 'jumpToTabIndex'; index: number }
  | { type: 'worktreeHistoryNavigate'; direction: 'back' | 'forward' }
  | { type: 'dictationKeyDown' }

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
    case 'toggleAgentDashboard':
      return 'dashboard.toggle'
    case 'switchRecentTab':
      return 'tab.previousRecent'
    case 'focusTabGroup':
      return action.direction === 1 ? 'tab.focusNextGroup' : 'tab.focusPreviousGroup'
    case 'worktreeHistoryNavigate':
      return action.direction === 'back' ? 'worktree.history.back' : 'worktree.history.forward'
    case 'dictationKeyDown':
      return 'voice.dictation'
    case 'jumpToWorktreeIndex':
      return 'workspace.selectByIndex'
    case 'jumpToTabIndex':
      return 'tab.selectByIndex'
  }
}
