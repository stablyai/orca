import type { WindowLayoutCommand } from './layout-apply-send'
import type { DrawnTabHold } from '@/runtime/workspace-layout/intents/layout-owner-drawn-tab-holds'

/** The tabs, by workspace, that a command the window already drew changes. */
export function drawnTabHolds(worktreeId: string, command: WindowLayoutCommand): DrawnTabHold[] {
  switch (command.type) {
    case 'closeTabs':
      return [{ workspace: worktreeId, ids: command.tabIds }]
    case 'splitGroup':
      return [{ workspace: worktreeId, ids: [command.tabId], groupLayout: true }]
    case 'moveTab':
    case 'renameTab':
    case 'setTabProps':
    case 'createTerminalTab':
      return [{ workspace: worktreeId, ids: [command.tabId] }]
    case 'setGroupRatios':
      return [{ workspace: worktreeId, ids: [], groupLayout: true }]
    // Pane commands hold their drawn tree; records are not frame-drawn. Editor/browser/chat/simulator opens and page changes send before drawing.
    case 'openBrowserTab':
    case 'openBrowserPage':
    case 'closeBrowserPage':
    case 'replaceTabContent':
    case 'setBrowserTabProfile':
    case 'openAgentSessionTab':
    case 'openSimulatorTab':
    case 'openRoomTab':
    case 'openEditorTab':
    case 'promotePreviewTab':
    case 'moveTabToWorkspace':
    case 'renameEditorFiles':
    case 'splitPane':
    case 'closePane':
    case 'renamePane':
    case 'equalizePanes':
    case 'movePane':
    case 'setPaneRatios':
    case 'setChatPane':
    case 'movePaneToNewTab':
    case 'sleep':
    case 'wake':
    case 'startPane':
    case 'setDefaultTabsApplied':
      return []
  }
}
