import { releaseRetiredAccountRestartSlots } from '@/components/terminal-pane/account-restart/detached/detached-pane-restart-slots'
import { withCodexAccountRestartPruning } from './codex-account-restart-continuation'
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TerminalSlice, TerminalStoreGet } from './terminal-state'

import { createTerminalEphemeralActions } from './terminal-ephemeral-state'
import { createTerminalTabCreationActions } from './tabs/creation/terminal-tab-creation'
import { createTerminalTabAgentLaunchPaneActions } from './tabs/creation/terminal-tab-agent-launch-pane'
import { createActiveWorkspaceTerminalActions } from './tabs/creation/terminal-active-workspace-creation'
import { createTerminalTabCloseActions } from './retirement/terminal-tab-close'
import { createTerminalTabNavigationActions } from './tabs/terminal-tab-navigation'
import { createTerminalTabPresentationActions } from './tabs/presentation/terminal-tab-presentation'
import { createTerminalTabAppearanceActions } from './tabs/presentation/terminal-tab-appearance'
import { routeTerminalTabChangesThroughLayoutOwner } from './tabs/presentation/terminal-tab-layout-owner-actions'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { createTerminalPtyBindingActions } from './pty/terminal-pty-bindings'
import { createTerminalPtyReleaseActions } from './pty/terminal-pty-release'
import { createTerminalUnverifiedPtyLossActions } from './pty/terminal-unverified-pty-loss'
import { createTerminalDisownedPtySourceActions } from './pty/terminal-disowned-pty-sources'
import { createTerminalPaneHibernationActions } from './sleep/terminal-pane-hibernation'
import { createTerminalShutdownActions } from './sleep/terminal-shutdown'
import { createTerminalRestartActions } from './pty/terminal-restart-state'
import { createTerminalLayoutActions } from './layout/terminal-layout-state'
import { createTerminalStartupQueueActions } from './tabs/creation/terminal-startup-queues'
import { createWorkspaceTerminalHydrationActions } from './hydration/workspace-terminal-hydration'
import { createWorkspaceTerminalReconnectActions } from './hydration/workspace-terminal-reconnect'
import { createPairedTerminalTabCloseIntentSlice } from './retirement/paired-terminal-tab-close-intent-actions'

export const createTerminalSlice: (
  ...args: [
    ...Parameters<StateCreator<AppState, [], [], TerminalSlice>>,
    isClaudeAgent?: Parameters<typeof createTerminalEphemeralActions>[2]
  ]
) => TerminalSlice = (setState, get, api, isClaudeAgent = undefined) => {
  const set: typeof setState = (update) => {
    const before = get().paneAccountRestarts
    try {
      setState((state) => {
        const patch = typeof update === 'function' ? update(state) : update
        return patch === state ? state : withCodexAccountRestartPruning(state, patch)
      })
    } finally {
      releaseRetiredAccountRestartSlots(before, get().paneAccountRestarts)
    }
  }
  return {
    tabsByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    suppressedPtyExitIds: {},
    pendingPtyShutdownIds: {},
    paneAccountRestarts: {},
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
  }
}

/** Switch point: a terminal tab's own changes go to main first, from every caller. */
function withLayoutOwnerTerminalTabChanges<
  T extends Parameters<typeof routeTerminalTabChangesThroughLayoutOwner>[0]
>(actions: T, get: TerminalStoreGet): T {
  return ORCA_LAYOUT_OWNER_IS_MAIN
    ? { ...actions, ...routeTerminalTabChangesThroughLayoutOwner(actions, get) }
    : actions
}
