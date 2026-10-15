import type { PhysicalModifierToken } from './keybindings'

export type WindowShortcutInput = {
  type?: string
  key?: string
  code?: string
  alt?: boolean
  meta?: boolean
  control?: boolean
  shift?: boolean
  altKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  // Set only by the double-tap detector; threads the synthetic input through
  // the main-process resolver so allowlisted actions can fire on double-tap.
  doubleTapModifier?: PhysicalModifierToken
}

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
  | { type: 'jumpToNextAttention' }
  | { type: 'switchRecentTab' }
  | { type: 'jumpToWorktreeIndex'; index: number }
  | { type: 'jumpToTabIndex'; index: number }
  | { type: 'worktreeHistoryNavigate'; direction: 'back' | 'forward' }
  | { type: 'dictationKeyDown' }
