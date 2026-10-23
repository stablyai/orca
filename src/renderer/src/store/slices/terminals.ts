import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TerminalSlice, TerminalStoreGet } from '../terminals/terminal-state'

export type { TerminalSlice } from '../terminals/terminal-state'
import { createTerminalEphemeralActions } from '../terminals/terminal-ephemeral-state'
import { createTerminalTabCreationActions } from '../terminals/terminal-tab-creation'
import { createTerminalTabAgentLaunchPaneActions } from '../terminals/terminal-tab-agent-launch-pane'
import { createActiveWorkspaceTerminalActions } from '../terminals/terminal-active-workspace-creation'
import { createTerminalTabCloseActions } from '../terminals/terminal-tab-close'
import { createTerminalTabNavigationActions } from '../terminals/terminal-tab-navigation'
import { createTerminalTabPresentationActions } from '../terminals/terminal-tab-presentation'
import { createTerminalTabAppearanceActions } from '../terminals/terminal-tab-appearance'
import { routeTerminalTabChangesThroughLayoutOwner } from '../terminals/terminal-tab-layout-owner-actions'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { createTerminalPtyBindingActions } from '../terminals/terminal-pty-bindings'
import { createTerminalPtyReleaseActions } from '../terminals/terminal-pty-release'
import { createTerminalUnverifiedPtyLossActions } from '../terminals/terminal-unverified-pty-loss'
import { createTerminalDisownedPtySourceActions } from '../terminals/terminal-disowned-pty-sources'
import { createTerminalPaneHibernationActions } from '../terminals/terminal-pane-hibernation'
import { createTerminalShutdownActions } from '../terminals/terminal-shutdown'
import { createTerminalRestartActions } from '../terminals/terminal-restart-state'
import { createTerminalLayoutActions } from '../terminals/terminal-layout-state'
import { createTerminalStartupQueueActions } from '../terminals/terminal-startup-queues'
import { createWorkspaceTerminalHydrationActions } from '../terminals/workspace-terminal-hydration'
import { createWorkspaceTerminalReconnectActions } from '../terminals/workspace-terminal-reconnect'
import { createPairedTerminalTabCloseIntentSlice } from '../terminals/paired-terminal-tab-close-intent-actions'
import { createTerminalDetachmentActions } from '../terminals/terminal-detachment'

export const createTerminalSlice: StateCreator<AppState, [], [], TerminalSlice> = (
  set,
  get,
  api
) => ({
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
  detachedTerminalByTabId: {},
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
  ...createTerminalEphemeralActions(set, get),
  ...createTerminalDetachmentActions(set, get),
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
