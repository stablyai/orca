import { seedPendingRuntimeRepoRemovals } from '@/store/repos/pending-runtime-repo-removals'
import { replayPendingRuntimeRepoRemovalsForReadyServers } from '@/store/repos/pending-runtime-repo-removal-replay'
import {
  DEFAULT_HIDE_SLEEPING_WORKSPACES,
  DEFAULT_SHOW_SLEEPING_WORKSPACES,
  DEFAULT_STATUS_BAR_ITEMS,
  DEFAULT_WORKTREE_CARD_PROPERTIES
} from '../../../shared/constants'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'

export function hydratePersistedUIAfterStartupRead({
  persistedUI,
  cancelled,
  hydratePersistedUI
}: {
  persistedUI: PersistedUIState
  cancelled: boolean
  hydratePersistedUI: (ui: PersistedUIState, source?: 'startup' | 'sync') => void
}): boolean {
  if (cancelled) {
    return false
  }

  // Before any catalog merge, so a server that still lists a removed project cannot re-add it.
  seedPendingRuntimeRepoRemovals(persistedUI.pendingRuntimeRepoRemovals)
  replayPendingRuntimeRepoRemovalsForReadyServers()
  hydratePersistedUI(persistedUI, 'startup')
  return true
}

export function getStartupErrorFallbackUI(uiHydrated: boolean): PersistedUIState | undefined {
  if (uiHydrated) {
    return undefined
  }

  // Startup failure still needs persistedUIReady (#1158), but defaults must not replace UI loaded before a later session failure.
  return {
    lastActiveRepoId: null,
    lastActiveWorktreeId: null,
    activeView: 'terminal',
    sidebarWidth: 280,
    rightSidebarOpen: true,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    rightSidebarWidth: 350,
    markdownTocPanelWidth: 240,
    combinedDiffFileTreeWidth: 256,
    groupBy: 'repo',
    sortBy: 'name',
    projectOrderBy: 'manual',
    showActiveOnly: false,
    hideSleepingWorkspaces: DEFAULT_HIDE_SLEEPING_WORKSPACES,
    showSleepingWorkspaces: DEFAULT_SHOW_SLEEPING_WORKSPACES,
    hideDefaultBranchWorkspace: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    alwaysShowDefaultBranchWorkspace: true,
    hideAutomationGeneratedWorkspaces: false,
    filterRepoIds: [],
    collapsedGroups: [],
    uiZoomLevel: 0,
    editorFontZoomLevel: 0,
    worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
    _worktreeCardModeDefaulted: true,
    statusBarItems: [...DEFAULT_STATUS_BAR_ITEMS],
    statusBarVisible: true,
    dismissedUpdateVersion: null,
    lastUpdateCheckAt: null
  }
}
