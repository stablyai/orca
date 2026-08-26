import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TerminalSlice } from '../terminals/terminal-state'
import { createTerminalEphemeralActions } from '../terminals/terminal-ephemeral-state'
import { createTerminalTabCreationActions } from '../terminals/terminal-tab-creation'
import { createActiveWorkspaceTerminalActions } from '../terminals/terminal-active-workspace-creation'
import { createTerminalTabCloseActions } from '../terminals/terminal-tab-close'
import { createTerminalTabNavigationActions } from '../terminals/terminal-tab-navigation'
import { createTerminalTabPresentationActions } from '../terminals/terminal-tab-presentation'
import { createTerminalTabAttentionActions } from '../terminals/terminal-tab-attention'
import { createTerminalPtyBindingActions } from '../terminals/terminal-pty-bindings'
import { createTerminalPtyReleaseActions } from '../terminals/terminal-pty-release'
import { createTerminalPaneHibernationActions } from '../terminals/terminal-pane-hibernation'
import { createDirectSshTerminalBindingActions } from '../terminals/direct-ssh-terminal-bindings'
import { createTerminalShutdownActions } from '../terminals/terminal-shutdown'
import { createTerminalRestartActions } from '../terminals/terminal-restart-state'
import { createTerminalLayoutActions } from '../terminals/terminal-layout-state'
import { createTerminalStartupQueueActions } from '../terminals/terminal-startup-queues'
import { createWorkspaceTerminalHydrationActions } from '../terminals/workspace-terminal-hydration'
import { createWorkspaceTerminalReconnectActions } from '../terminals/workspace-terminal-reconnect'

export const createTerminalSlice: StateCreator<AppState, [], [], TerminalSlice> = (set, get) => ({
  tabsByWorktree: {},
  activeTabId: null,
  activeTabIdByWorktree: {},
  ptyIdsByTabId: {},
  runtimePaneTitlesByTabId: {},
  unreadTerminalTabs: {},
  unreadTerminalPanes: {},
  unreadAgentCompletionPanes: {},
  suppressedPtyExitIds: {},
  pendingPtyShutdownIds: {},
  pendingCodexPaneRestartIds: {},
  codexRestartNoticeByPtyId: {},
  directSshPaneRetryByTabId: {},
  directSshLivePtyBindingByTabId: {},
  directSshPaneRetryHistoryByTabId: {},
  expandedPaneByTabId: {},
  canExpandPaneByTabId: {},
  terminalLayoutsByTabId: {},
  pendingStartupByTabId: {},
  pendingInitialCwdByTabId: {},
  pendingSetupSplitByTabId: {},
  pendingIssueCommandSplitByTabId: {},
  automaticAgentResumeClaimsByTabId: {},
  nativeChatLaunchPromptByTabId: {},
  nativeChatLaunchDraftByTabId: {},
  tabBarOrderByWorktree: {},
  workspaceSessionReady: false,
  restoredRuntimeHostIdByWorkspaceSessionKey: {},
  defaultTerminalTabsAppliedByWorktreeId: {},
  hydrationSucceeded: false,
  pendingReconnectWorktreeIds: [],
  pendingReconnectTabByWorktree: {},
  pendingReconnectPtyIdByTabId: {},
  lastKnownRelayPtyIdByTabId: {},
  pendingSnapshotByPtyId: {},
  pendingColdRestoreByPtyId: {},
  deferredSshReconnectTargets: [],
  deferredSshSessionIdsByTabId: {},
  cacheTimerByKey: {},
  lastTerminalInputAtByPaneKey: {},
  recentQuickCommandIdByGroup: {},
  ...createTerminalEphemeralActions(set, get),
  ...createTerminalTabCreationActions(set, get),
  ...createActiveWorkspaceTerminalActions(set, get),
  ...createTerminalTabCloseActions(set, get),
  ...createTerminalTabNavigationActions(set, get),
  ...createTerminalTabPresentationActions(set, get),
  ...createTerminalTabAttentionActions(set, get),
  ...createTerminalPtyBindingActions(set, get),
  ...createTerminalPtyReleaseActions(set, get),
  ...createTerminalPaneHibernationActions(set, get),
  ...createDirectSshTerminalBindingActions(set, get),
  ...createTerminalShutdownActions(set, get),
  ...createTerminalRestartActions(set, get),
  ...createTerminalLayoutActions(set, get),
  ...createTerminalStartupQueueActions(set, get),
  ...createWorkspaceTerminalHydrationActions(set, get),
  ...createWorkspaceTerminalReconnectActions(set, get)
})
