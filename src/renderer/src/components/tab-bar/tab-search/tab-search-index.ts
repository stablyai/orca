import type { AppState } from '@/store/types'
import { buildSearchableBrowserPages } from '@/lib/browser/palette/browser-palette-page-entries'
import type { SearchableBrowserPage } from '@/lib/browser/palette/browser-palette-search'
import { buildSearchableSimulatorTabs } from '@/lib/simulator/search/simulator-palette-search'
import type { SearchableSimulatorTab } from '@/lib/simulator/search/simulator-palette-search-types'
import { createWorkspaceTabPaletteIndex } from '@/lib/workspace/search/tabs/workspace-tab-palette-index'
import type { SearchableWorkspaceTab } from '@/lib/workspace/search/tabs/workspace-tab-search-types'
import { isPaletteCurrentWorktree } from '@/lib/workspace/search/palette-repo-resolution'
import { orderEmptyQueryWorktrees } from '@/lib/workspace/search/palette/order-empty-query-worktrees'
import { buildPaletteWorkspaces } from '@/lib/workspace/search/palette-workspaces'
import {
  readHiddenVmCheckouts,
  withoutHiddenVmWorktreesByRepo
} from '@/runtime/ephemeral-vm/vm-create-hidden-checkouts'
import { getStructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-name-observation'
import { buildWorktreeJumpPaletteWorktreeMaps } from '@/components/worktree-jump/workspaces/worktree-jump-palette-worktree-maps'
import { getRepoHostIdentity } from '../../../../../shared/repository/repo-host-identity'
import type { Worktree } from '../../../../../shared/worktree/types'

/** One open popup's snapshot: Cmd+J's searchable tab entries plus each tab's last user focus. */
export type TabSearchIndex = {
  workspaceTabs: readonly SearchableWorkspaceTab[]
  browserPages: readonly SearchableBrowserPage[]
  simulatorTabs: readonly SearchableSimulatorTab[]
  /** Keyed by tabSearchFocusKey; agent output never counts as focus, unlike Cmd+J's activity. */
  lastFocusedAt: ReadonlyMap<string, number>
}

export function tabSearchFocusKey(worktreeId: string, tabId: string): string {
  return `${worktreeId}\u0000${tabId}`
}

export function tabSearchBrowserFocusKey(worktreeId: string, browserWorkspaceId: string): string {
  return `${worktreeId}\u0000browser\u0000${browserWorkspaceId}`
}

function orderWorktreesByVisit(state: AppState, workspaces: readonly Worktree[]): Worktree[] {
  const current = workspaces.filter((worktree) =>
    isPaletteCurrentWorktree(worktree, state.activeWorktreeId, state.activeWorkspaceExecutionHostId)
  )
  const { switchableWorktreesForRows } = orderEmptyQueryWorktrees({
    visibleWorktrees: workspaces,
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    lastVisitedAtByWorktreeId: state.lastVisitedAtByWorktreeId
  })
  return [...current, ...switchableWorktreesForRows]
}

function collectLastFocusedAt(state: AppState): Map<string, number> {
  const lastFocusedAt = new Map<string, number>()
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    for (const tab of tabs ?? []) {
      if (tab.lastFocusedAt === undefined) {
        continue
      }
      lastFocusedAt.set(tabSearchFocusKey(worktreeId, tab.id), tab.lastFocusedAt)
      if (tab.contentType === 'browser') {
        lastFocusedAt.set(tabSearchBrowserFocusKey(worktreeId, tab.entityId), tab.lastFocusedAt)
      }
    }
  }
  return lastFocusedAt
}

/** Built when the popup opens (and after a close from the list), never while it is closed. */
export function buildTabSearchIndex(state: AppState): TabSearchIndex {
  const worktreesByRepo = withoutHiddenVmWorktreesByRepo(
    state.worktreesByRepo,
    readHiddenVmCheckouts()
  )
  const workspaces = buildPaletteWorkspaces({
    worktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    repos: state.repos,
    projectGroups: state.projectGroups
  })
  const worktrees = orderWorktreesByVisit(state, workspaces)
  const { worktreeOrder } = buildWorktreeJumpPaletteWorktreeMaps(worktrees)
  const shared = {
    worktrees,
    ownershipWorktrees: workspaces,
    repoMap: new Map(state.repos.map((repo) => [repo.id, repo])),
    repoMapByHostIdentity: new Map(state.repos.map((repo) => [getRepoHostIdentity(repo), repo])),
    worktreeOrder,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    activeTabType: state.activeTabType
  }
  return {
    workspaceTabs: createWorkspaceTabPaletteIndex()({
      ...shared,
      tabsByWorktree: state.tabsByWorktree,
      openFiles: state.openFiles,
      agentStatusByPaneKey: state.agentStatusByPaneKey,
      sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
      activeGroupIdByWorktree: state.activeGroupIdByWorktree,
      groupsByWorktree: state.groupsByWorktree,
      activeTabId: state.activeTabId,
      activeTabIdByWorktree: state.activeTabIdByWorktree,
      activeFileId: state.activeFileId,
      activeFileIdByWorktree: state.activeFileIdByWorktree,
      activeTabTypeByWorktree: state.activeTabTypeByWorktree,
      generatedTitlesEnabled: state.settings?.tabAutoGenerateTitle === true,
      chatNames: getStructuredChatTabNames(),
      terminalLayoutsByTabId: state.terminalLayoutsByTabId,
      paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey
    }),
    browserPages: buildSearchableBrowserPages({
      ...shared,
      browserTabsByWorktree: state.browserTabsByWorktree,
      browserPagesByWorkspace: state.browserPagesByWorkspace,
      activeBrowserTabId: state.activeBrowserTabId
    }),
    simulatorTabs: buildSearchableSimulatorTabs({
      ...shared,
      activeGroupIdByWorktree: state.activeGroupIdByWorktree,
      groupsByWorktree: state.groupsByWorktree
    }),
    lastFocusedAt: collectLastFocusedAt(state)
  }
}
