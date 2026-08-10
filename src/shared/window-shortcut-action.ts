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
  | { type: 'switchRecentTab' }
  | { type: 'jumpToSpaceIndex'; index: number }
  | { type: 'spaceNavigate'; direction: 'next' | 'previous' }
  | { type: 'jumpToWorktreeIndex'; index: number }
  | { type: 'jumpToTabIndex'; index: number }
  | { type: 'worktreeHistoryNavigate'; direction: 'back' | 'forward' }
  | { type: 'dictationKeyDown' }
