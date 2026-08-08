// Builds one worktree's tabs, browser pages and simulator tabs into the shapes
// the three Cmd+J engines search.

import type { Repo, Worktree } from '../../../../shared/types'
import { buildSearchableBrowserPages } from '@/lib/browser-palette-page-entries'
import type { SearchableBrowserPage } from '@/lib/browser-palette-search'
import {
  buildSearchableSimulatorTabs,
  type SearchableSimulatorTab
} from '@/lib/simulator-palette-search'
import {
  buildSearchableWorkspaceTabs,
  type SearchableWorkspaceTab
} from '@/lib/workspace-tab-palette-search'
import type { AppState } from '@/store/types'

export type OpenTabSearchEntries = {
  workspaceTabs: readonly SearchableWorkspaceTab[]
  browserPages: readonly SearchableBrowserPage[]
  simulatorTabs: readonly SearchableSimulatorTab[]
}

export type OpenTabSearchEntryState = Pick<
  AppState,
  | 'activeBrowserTabId'
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
  | 'activeWorktreeId'
  | 'agentStatusByPaneKey'
  | 'browserPagesByWorkspace'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'openFiles'
  | 'retainedAgentsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
> & {
  generatedTitlesEnabled: boolean
  repo: Pick<Repo, 'displayName' | 'id'> | null
  worktree: Worktree | null
}

const EMPTY_ENTRIES: OpenTabSearchEntries = {
  workspaceTabs: [],
  browserPages: [],
  simulatorTabs: []
}

// No group id: every tab of the worktree is offered, including the one the
// column already shows, matching how Cmd+J lists the tab you are on.
export function selectOpenTabSearchEntryState(
  state: AppState,
  worktreeId: string
): OpenTabSearchEntryState {
  // Why getKnownWorktreeById: folder workspaces are absent from worktreesByRepo.
  const worktree = state.getKnownWorktreeById(worktreeId) ?? null
  return {
    activeBrowserTabId: state.activeBrowserTabId,
    activeFileId: state.activeFileId,
    activeFileIdByWorktree: state.activeFileIdByWorktree,
    activeGroupIdByWorktree: state.activeGroupIdByWorktree,
    activeTabId: state.activeTabId,
    activeTabIdByWorktree: state.activeTabIdByWorktree,
    activeTabType: state.activeTabType,
    activeTabTypeByWorktree: state.activeTabTypeByWorktree,
    activeWorktreeId: state.activeWorktreeId,
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    browserPagesByWorkspace: state.browserPagesByWorkspace,
    browserTabsByWorktree: state.browserTabsByWorktree,
    generatedTitlesEnabled: state.settings?.tabAutoGenerateTitle === true,
    groupsByWorktree: state.groupsByWorktree,
    openFiles: state.openFiles,
    repo: worktree
      ? (state.repos.find((candidate) => candidate.id === worktree.repoId) ?? null)
      : null,
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    tabsByWorktree: state.tabsByWorktree,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    worktree
  }
}

export function buildOpenTabSearchEntries(state: OpenTabSearchEntryState): OpenTabSearchEntries {
  if (!state.worktree) {
    return EMPTY_ENTRIES
  }

  const { repo, worktree } = state
  const worktrees = [worktree]
  const scope = {
    worktrees,
    repoMap: new Map(repo ? [[repo.id, { displayName: repo.displayName }]] : []),
    worktreeOrder: new Map([[worktree.id, 0]])
  }

  return {
    workspaceTabs: buildSearchableWorkspaceTabs({
      ...scope,
      unifiedTabsByWorktree: state.unifiedTabsByWorktree,
      tabsByWorktree: state.tabsByWorktree,
      openFiles: state.openFiles,
      agentStatusByPaneKey: state.agentStatusByPaneKey,
      retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
      sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
      activeGroupIdByWorktree: state.activeGroupIdByWorktree,
      groupsByWorktree: state.groupsByWorktree,
      activeWorktreeId: state.activeWorktreeId,
      activeTabType: state.activeTabType,
      activeTabId: state.activeTabId,
      activeTabIdByWorktree: state.activeTabIdByWorktree,
      activeFileId: state.activeFileId,
      activeFileIdByWorktree: state.activeFileIdByWorktree,
      activeTabTypeByWorktree: state.activeTabTypeByWorktree,
      generatedTitlesEnabled: state.generatedTitlesEnabled
    }),
    browserPages: buildSearchableBrowserPages({
      ...scope,
      browserTabsByWorktree: state.browserTabsByWorktree,
      browserPagesByWorkspace: state.browserPagesByWorkspace,
      activeBrowserTabId: state.activeBrowserTabId,
      activeWorktreeId: state.activeWorktreeId,
      activeTabType: state.activeTabType
    }),
    simulatorTabs: buildSearchableSimulatorTabs({
      ...scope,
      unifiedTabsByWorktree: state.unifiedTabsByWorktree,
      activeGroupIdByWorktree: state.activeGroupIdByWorktree,
      groupsByWorktree: state.groupsByWorktree,
      activeWorktreeId: state.activeWorktreeId,
      activeTabType: state.activeTabType
    })
  }
}
