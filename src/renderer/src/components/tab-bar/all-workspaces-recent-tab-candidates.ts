// Collects the Ctrl+Tab rows of the all-workspaces scope: the open-tab entries Cmd+J searches,
// plus agent chats, each with its last focus time and its place on screen.

import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { resolveUnifiedTabLabel } from '../../../../shared/tab-title-resolution'
import type { Worktree } from '../../../../shared/worktree/types'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import { buildSearchableBrowserPages } from '@/lib/browser-palette-page-entries'
import { formatBrowserPaletteUrl } from '@/lib/browser-palette-search'
import {
  dedupePaletteWorktrees,
  getPaletteWorktreeIdentity,
  isPaletteCurrentWorktree,
  resolvePaletteRepoForWorktree
} from '@/lib/palette-repo-resolution'
import { encodePaletteIdentity } from '@/lib/palette-match/palette-ranking'
import {
  buildSearchableSimulatorTabs,
  simulatorPaletteTabTitle
} from '@/lib/simulator-palette-search'
import {
  findAmbiguousWorktreeIds,
  findDuplicateIds,
  getUnifiedTabPaletteExecutionHostId,
  isUnifiedTabOwnedByWorktree
} from '@/lib/unified-tab-host-ownership'
import { buildSearchableWorkspaceTabs } from '@/lib/workspace-tab-palette-search'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { getFolderWorkspaceWorktree } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import type { VisibleWorktreeShortcutTarget } from '../sidebar/visible-worktrees'
import { buildWorktreeJumpPaletteWorktreeMaps } from '../worktree-jump-palette-worktree-maps'
import type {
  AllWorkspacesRecentTabItem,
  AllWorkspacesRecentTabState
} from './all-workspaces-recent-tab-switching'
import { createTabStripPositioner } from './all-workspaces-tab-strip-position'

export type Candidate = {
  item: AllWorkspacesRecentTabItem
  lastFocusedAt?: number
  isCurrent: boolean
  /** Sidebar row, pane from left to right, place in the tab strip, browser page. */
  position: readonly number[]
}

function formatLocation(repoName: string, worktree: Worktree): string {
  const worktreeName = resolveWorktreeDisplayName(worktree)
  return repoName && repoName !== worktreeName ? `${repoName} · ${worktreeName}` : worktreeName
}

function rowKey(kind: string, worktree: Worktree, id: string): string {
  return encodePaletteIdentity([kind, getPaletteWorktreeIdentity(worktree), id])
}

export function collectAllWorkspacesRecentTabCandidates(
  state: AllWorkspacesRecentTabState,
  sidebarOrder: readonly VisibleWorktreeShortcutTarget[]
): Candidate[] {
  const ownershipWorktrees = dedupePaletteWorktrees([
    ...Object.values(selectWorktreesByRepo(state)).flat(),
    ...selectFolderWorkspaces(state).map(getFolderWorkspaceWorktree)
  ])
  const worktrees = ownershipWorktrees.filter((worktree) => !worktree.isArchived)
  const positionOf = createTabStripPositioner(state, worktrees, sidebarOrder)
  const scope = {
    worktrees,
    ownershipWorktrees,
    repoMap: new Map(state.repos.map((repo) => [repo.id, repo])),
    repoMapByHostIdentity: new Map(state.repos.map((repo) => [getRepoHostIdentity(repo), repo])),
    worktreeOrder: buildWorktreeJumpPaletteWorktreeMaps(worktrees).worktreeOrder,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    activeTabType: state.activeTabType
  }
  const dirtyFileIds = new Set(
    state.openFiles.filter((file) => file.isDirty).map((file) => file.id)
  )
  const generatedTitlesEnabled = state.settings?.tabAutoGenerateTitle === true

  const workspaceTabs = buildSearchableWorkspaceTabs({
    ...scope,
    tabsByWorktree: state.tabsByWorktree,
    openFiles: state.openFiles,
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    activeGroupIdByWorktree: state.activeGroupIdByWorktree,
    groupsByWorktree: state.groupsByWorktree,
    activeTabId: state.activeTabId,
    activeTabIdByWorktree: state.activeTabIdByWorktree,
    activeFileId: state.activeFileId,
    activeFileIdByWorktree: state.activeFileIdByWorktree,
    activeTabTypeByWorktree: state.activeTabTypeByWorktree,
    generatedTitlesEnabled,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey
  }).map((entry): Candidate => {
    const key = rowKey('tab', entry.worktree, entry.tab.id)
    return {
      lastFocusedAt: entry.tab.lastFocusedAt,
      isCurrent: entry.isCurrentTab,
      position: positionOf(entry.worktree, entry.tab),
      item: {
        key,
        label: entry.title,
        location: formatLocation(entry.repoName, entry.worktree),
        type: entry.tab.contentType === 'terminal' ? 'terminal' : 'editor',
        contentType: entry.tab.contentType,
        isDirty: entry.tab.contentType !== 'terminal' && dirtyFileIds.has(entry.tab.entityId),
        agent: entry.tab.contentType === 'terminal' ? entry.occupantAgent : null,
        result: {
          source: 'workspace',
          executionHostId:
            getUnifiedTabPaletteExecutionHostId(entry.tab, entry.worktree) ??
            LOCAL_EXECUTION_HOST_ID,
          id: key,
          title: entry.title,
          matchedText: null,
          worktreeId: entry.worktree.id,
          contentType: entry.tab.contentType,
          tabId: entry.tab.id,
          entityId: entry.tab.entityId,
          groupId: entry.tab.groupId,
          relativePath: null,
          occupantAgent: entry.occupantAgent
        }
      }
    }
  })

  const browserPages = buildSearchableBrowserPages({
    ...scope,
    browserTabsByWorktree: state.browserTabsByWorktree,
    browserPagesByWorkspace: state.browserPagesByWorkspace,
    activeBrowserTabId: state.activeBrowserTabId
  }).map((entry): Candidate => {
    const title = entry.page.title || formatBrowserPaletteUrl(entry.page.url)
    const key = rowKey('page', entry.worktree, entry.page.id)
    const browserTab = (state.unifiedTabsByWorktree[entry.worktree.id] ?? []).find(
      (tab) => tab.contentType === 'browser' && tab.entityId === entry.workspace.id
    )
    const pages = state.browserPagesByWorkspace[entry.workspace.id] ?? []
    return {
      lastFocusedAt: entry.lastFocusedAt,
      isCurrent: entry.isCurrentPage,
      position: positionOf(entry.worktree, browserTab, pages.indexOf(entry.page)),
      item: {
        key,
        label: title,
        location: formatLocation(entry.repoName, entry.worktree),
        type: 'browser',
        contentType: 'browser',
        isDirty: false,
        agent: null,
        result: {
          source: 'browser',
          executionHostId: entry.executionHostId ?? LOCAL_EXECUTION_HOST_ID,
          id: key,
          title,
          matchedText: null,
          worktreeId: entry.worktree.id,
          contentType: 'browser',
          pageId: entry.page.id,
          workspaceId: entry.workspace.id,
          url: entry.page.url,
          faviconUrl: entry.page.faviconUrl ?? null
        }
      }
    }
  })

  const simulatorTabs = buildSearchableSimulatorTabs({
    ...scope,
    activeGroupIdByWorktree: state.activeGroupIdByWorktree,
    groupsByWorktree: state.groupsByWorktree
  }).map((entry): Candidate => {
    const title = simulatorPaletteTabTitle(entry.tab)
    const key = rowKey('simulator', entry.worktree, entry.tab.id)
    return {
      lastFocusedAt: entry.tab.lastFocusedAt,
      isCurrent: entry.isCurrentTab,
      position: positionOf(entry.worktree, entry.tab),
      item: {
        key,
        label: title,
        location: formatLocation(entry.repoName, entry.worktree),
        type: 'simulator',
        contentType: 'simulator',
        isDirty: false,
        agent: null,
        result: {
          source: 'simulator',
          executionHostId:
            getUnifiedTabPaletteExecutionHostId(entry.tab, entry.worktree) ??
            LOCAL_EXECUTION_HOST_ID,
          id: key,
          title,
          matchedText: null,
          worktreeId: entry.worktree.id,
          contentType: 'simulator',
          tabId: entry.tab.id,
          groupId: entry.tab.groupId
        }
      }
    }
  })

  // Why: Cmd+J does not list agent chats, so their rows come straight from the unified tabs.
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(ownershipWorktrees)
  const agentSessionTabs = worktrees.flatMap((worktree) => {
    const tabs = state.unifiedTabsByWorktree[worktree.id] ?? []
    const duplicateTabIds = findDuplicateIds(tabs)
    const activeGroupId = state.activeGroupIdByWorktree[worktree.id]
    // Why: as in This workspace, the focused group's active tab is the one on screen.
    const shownTabId = isPaletteCurrentWorktree(
      worktree,
      state.activeWorktreeId,
      state.activeWorkspaceExecutionHostId
    )
      ? (state.groupsByWorktree[worktree.id] ?? []).find((group) => group.id === activeGroupId)
          ?.activeTabId
      : undefined
    const repoName =
      resolvePaletteRepoForWorktree(worktree, scope.repoMap, scope.repoMapByHostIdentity)
        ?.displayName ?? ''
    return tabs.flatMap((tab): Candidate[] => {
      if (
        tab.contentType !== 'agent-session' ||
        duplicateTabIds.has(tab.id) ||
        !isUnifiedTabOwnedByWorktree(tab, worktree, ambiguousWorktreeIds)
      ) {
        return []
      }
      return [
        {
          lastFocusedAt: tab.lastFocusedAt,
          isCurrent: tab.id === shownTabId,
          position: positionOf(worktree, tab),
          item: {
            key: rowKey('agent-session', worktree, tab.id),
            label: resolveUnifiedTabLabel(tab, generatedTitlesEnabled, tab.entityId),
            location: formatLocation(repoName, worktree),
            type: 'agent-session',
            contentType: 'agent-session',
            isDirty: false,
            agent: agentTypeToIconAgent(tab.agentSessionAgent),
            result: {
              source: 'agent-session',
              executionHostId:
                getUnifiedTabPaletteExecutionHostId(tab, worktree) ?? LOCAL_EXECUTION_HOST_ID,
              worktreeId: worktree.id,
              tabId: tab.id
            }
          }
        }
      ]
    })
  })

  return [...workspaceTabs, ...browserPages, ...simulatorTabs, ...agentSessionTabs]
}
