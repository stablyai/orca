import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TerminalSlice, TerminalStoreGet } from './terminal-state'

import { createTerminalEphemeralActions } from './terminal-ephemeral-state'
import { createTerminalTabCreationActions } from './terminal-tab-creation'
import { createTerminalTabAgentLaunchPaneActions } from './terminal-tab-agent-launch-pane'
import { createActiveWorkspaceTerminalActions } from './terminal-active-workspace-creation'
import { createTerminalTabCloseActions } from './terminal-tab-close'
import { createTerminalTabNavigationActions } from './terminal-tab-navigation'
import { createTerminalTabPresentationActions } from './terminal-tab-presentation'
import { createTerminalTabAppearanceActions } from './terminal-tab-appearance'
import { routeTerminalTabChangesThroughLayoutOwner } from './terminal-tab-layout-owner-actions'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { createTerminalPtyBindingActions } from './terminal-pty-bindings'
import { createTerminalPtyReleaseActions } from './terminal-pty-release'
import { createTerminalUnverifiedPtyLossActions } from './terminal-unverified-pty-loss'
import { createTerminalDisownedPtySourceActions } from './terminal-disowned-pty-sources'
import { createTerminalPaneHibernationActions } from './terminal-pane-hibernation'
import { createTerminalShutdownActions } from './terminal-shutdown'
import { createTerminalRestartActions } from './terminal-restart-state'
import { createTerminalLayoutActions } from './terminal-layout-state'
import { createTerminalStartupQueueActions } from './terminal-startup-queues'
import { createWorkspaceTerminalHydrationActions } from './workspace-terminal-hydration'
import { createWorkspaceTerminalReconnectActions } from './workspace-terminal-reconnect'
import { createPairedTerminalTabCloseIntentSlice } from './paired-terminal-tab-close-intent-actions'

export const createTerminalSlice: (
  ...args: [
    ...Parameters<StateCreator<AppState, [], [], TerminalSlice>>,
    isClaudeAgent?: Parameters<typeof createTerminalEphemeralActions>[2]
  ]
) => TerminalSlice = (set, get, api, isClaudeAgent = undefined) => ({
  tabsByWorktree: {},
  activeTabId: null,
  activeTabIdByWorktree: {},
  ptyIdsByTabId: {},
  runtimePaneTitlesByTabId: {},
  suppressedPtyExitIds: {},
  pendingPtyShutdownIds: {},
  pendingPaneAccountRestarts: {},
  codexRestartNoticeByPtyId: {},
  expandedPaneByTabId: {},
  canExpandPaneByTabId: {},
  terminalLayoutsByTabId: {},
  terminalPaneStartsByPaneKey: {},
  terminalPaneResumeOutcomesByPaneKey: {},
  localOnlyScrollbackByTabId: {},
  pendingStartupByTabId: {},
  pendingInitialCwdByTabId: {},
  pendingIssueCommandSplitByTabId: {},
  automaticAgentResumeClaimsByTabId: {},
  nativeChatLaunchPromptByTabId: {},
  nativeChatLaunchDraftByTabId: {},
  tabBarOrderByWorktree: {},
  workspaceSessionReady: false,
  terminalStartupRestorationReady: false,
  setTerminalStartupRestorationReady: (value) => {
    set({ terminalStartupRestorationReady: value })
  },
  restoredRuntimeHostIdByWorkspaceSessionKey: {},
  contestedHostWorkspaceSessions: {},
  contestedPrimaryHostBySessionKey: {},
  hydratedRuntimeSessionHostIds: [],
  defaultTerminalTabsAppliedByWorktreeId: {},
  closedTerminalTabTombstonesByTabId: {},
  hydrationSucceeded: false,
  pendingReconnectWorktreeIds: [],
  pendingReconnectTabByWorktree: {},
  pendingReconnectPtyIdByTabId: {},
  lastKnownRelayPtyIdByTabId: {},
  unverifiedPtyLossTabIds: {},
  disownedPtyIds: {},
  pendingSnapshotByPtyId: {},
  pendingColdRestoreByPtyId: {},
  deferredSshReconnectTargets: [],
  deferredSshSessionIdsByTabId: {},
  cacheTimerByKey: {},
  lastTerminalInputAtByPaneKey: {},
  recentQuickCommandIdByGroup: {},
  ...createTerminalEphemeralActions(set, get, isClaudeAgent),
  ...createTerminalTabCreationActions(set, get, api.subscribe),
  ...createTerminalTabAgentLaunchPaneActions(set),
  ...createActiveWorkspaceTerminalActions(set, get),
  ...createTerminalTabCloseActions(set, get),
  ...createTerminalTabNavigationActions(set, get),
  ...withLayoutOwnerTerminalTabChanges(
    {
      ...createTerminalTabPresentationActions(set, get),
      ...createTerminalTabAppearanceActions(set, get)
    },
    get
  ),
  ...createTerminalPtyBindingActions(set, get),
  ...createTerminalPtyReleaseActions(set, get),
  ...createTerminalUnverifiedPtyLossActions(set),
  ...createTerminalDisownedPtySourceActions(set),
  ...createTerminalPaneHibernationActions(set, get),
  ...createTerminalShutdownActions(set, get),
  ...createTerminalRestartActions(set, get),
  ...createTerminalLayoutActions(set, get),
  ...createTerminalStartupQueueActions(set, get),
  ...createWorkspaceTerminalHydrationActions(set, get),
  ...createWorkspaceTerminalReconnectActions(set, get),
  ...createPairedTerminalTabCloseIntentSlice(set)
})

/** Switch point: a terminal tab's own changes go to main first, from every caller. */
function withLayoutOwnerTerminalTabChanges<
  T extends Parameters<typeof routeTerminalTabChangesThroughLayoutOwner>[0]
>(actions: T, get: TerminalStoreGet): T {
  return ORCA_LAYOUT_OWNER_IS_MAIN
    ? { ...actions, ...routeTerminalTabChangesThroughLayoutOwner(actions, get) }
    : actions
}
