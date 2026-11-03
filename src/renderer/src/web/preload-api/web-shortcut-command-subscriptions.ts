import type { PreloadApi } from '../../../../preload/api-types'
import { noopUnsubscribe } from './web-storage'

// Why: main-process menu and global-shortcut commands never reach a paired web client.
export const webShortcutCommandSubscriptions = {
  onToggleLeftSidebar: () => noopUnsubscribe,
  onToggleRightSidebar: () => noopUnsubscribe,
  onToggleWorktreePalette: () => noopUnsubscribe,
  onToggleFloatingTerminal: () => noopUnsubscribe,
  onTerminalShortcutCaptured: () => noopUnsubscribe,
  onOpenQuickOpen: () => noopUnsubscribe,
  onToggleQuickCommandsMenu: () => noopUnsubscribe,
  onOpenTasks: () => noopUnsubscribe,
  onOpenNewWorkspace: () => noopUnsubscribe,
  onDeleteCurrentWorkspace: () => noopUnsubscribe,
  onOpenWorkspaceBoard: () => noopUnsubscribe,
  onToggleAgentDashboard: () => noopUnsubscribe,
  onJumpToNextAttention: () => noopUnsubscribe,
  onJumpToWorktreeIndex: () => noopUnsubscribe,
  onJumpToTabIndex: () => noopUnsubscribe,
  onWorktreeHistoryNavigate: () => noopUnsubscribe
} satisfies Partial<PreloadApi['ui']>
