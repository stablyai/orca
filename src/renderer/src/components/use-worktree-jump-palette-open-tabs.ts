import { useMemo } from 'react'
import { buildSearchableBrowserPages } from '@/lib/browser-palette-page-entries'
import { searchBrowserPages, type SearchableBrowserPage } from '@/lib/browser-palette-search'
import {
  buildSearchableSimulatorTabs,
  searchSimulatorTabs,
  type SearchableSimulatorTab
} from '@/lib/simulator-palette-search'
import {
  buildSearchableWorkspaceTabs,
  searchWorkspaceTabs,
  type SearchableWorkspaceTab
} from '@/lib/workspace-tab-palette-search'
import { comparePaletteRankedItems } from '@/lib/cmd-j-section-leadership'
import { getPaletteWorktreeIdentity } from '@/lib/palette-repo-resolution'
import type {
  BrowserPaletteItem,
  OpenTabPaletteItem,
  SimulatorPaletteItem,
  WorkspaceTabPaletteItem,
  WorktreePaletteItem
} from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { WorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'
import {
  encodePaletteIdentity,
  type PaletteSearchContext
} from '@/lib/palette-match/palette-ranking'
import {
  buildBrowserPaletteItems,
  buildOpenTabPaletteItems,
  buildSimulatorPaletteItems,
  buildWorkspaceTabPaletteItems
} from './worktree-jump-palette-open-tab-items'

const EMPTY_BROWSER_PAGE_ENTRIES: SearchableBrowserPage[] = []
const EMPTY_SIMULATOR_TAB_ENTRIES: SearchableSimulatorTab[] = []
const EMPTY_WORKSPACE_TAB_ENTRIES: SearchableWorkspaceTab[] = []

type WorktreeJumpPaletteOpenTabsInput = WorktreeJumpPaletteStoreState &
  WorktreeJumpPaletteWorktrees &
  Pick<WorktreeJumpPaletteFilter, 'repoMap' | 'repoByHostIdentity'> &
  Pick<WorktreeJumpPaletteLocalState, 'deferredQuery'> & {
    paletteSearchContext: PaletteSearchContext
  }

export function useWorktreeJumpPaletteOpenTabs({
  paletteStatusInputsActive,
  browserSortedWorktrees,
  allWorktrees,
  repoMap,
  repoByHostIdentity,
  worktreeOrder,
  browserTabsByWorktree,
  browserPagesByWorkspace,
  activeBrowserTabId,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  activeTabType,
  unifiedTabsByWorktree,
  activeGroupIdByWorktree,
  groupsByWorktree,
  tabsByWorktree,
  openFiles,
  agentStatusByPaneKey,
  retainedAgentsByPaneKey,
  sleepingAgentSessionsByPaneKey,
  activeTabId,
  activeTabIdByWorktree,
  activeFileId,
  activeFileIdByWorktree,
  activeTabTypeByWorktree,
  settings,
  terminalLayoutsByTabId,
  paneForegroundAgentByPaneKey,
  deferredQuery,
  paletteSearchContext,
  hasQuery,
  worktreeMatches,
  resolveWorktree
}: WorktreeJumpPaletteOpenTabsInput) {
  const browserPageEntries = useMemo<SearchableBrowserPage[]>(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_BROWSER_PAGE_ENTRIES
    }
    return buildSearchableBrowserPages({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: allWorktrees,
      repoMap,
      repoMapByHostIdentity: repoByHostIdentity,
      worktreeOrder,
      browserTabsByWorktree,
      browserPagesByWorkspace,
      activeBrowserTabId,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType,
      unifiedTabsByWorktree
    })
  }, [
    paletteStatusInputsActive,
    activeBrowserTabId,
    activeTabType,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    allWorktrees,
    browserPagesByWorkspace,
    browserTabsByWorktree,
    browserSortedWorktrees,
    repoByHostIdentity,
    repoMap,
    unifiedTabsByWorktree,
    worktreeOrder
  ])
  const browserMatches = useMemo(
    () =>
      searchBrowserPages(browserPageEntries, deferredQuery.trim(), {
        context: paletteSearchContext
      }),
    [browserPageEntries, deferredQuery, paletteSearchContext]
  )
  const simulatorTabEntries = useMemo<SearchableSimulatorTab[]>(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_SIMULATOR_TAB_ENTRIES
    }
    return buildSearchableSimulatorTabs({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: allWorktrees,
      repoMap,
      repoMapByHostIdentity: repoByHostIdentity,
      worktreeOrder,
      unifiedTabsByWorktree,
      activeGroupIdByWorktree,
      groupsByWorktree,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType
    })
  }, [
    paletteStatusInputsActive,
    activeGroupIdByWorktree,
    activeTabType,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    allWorktrees,
    browserSortedWorktrees,
    groupsByWorktree,
    repoByHostIdentity,
    repoMap,
    unifiedTabsByWorktree,
    worktreeOrder
  ])
  const simulatorMatches = useMemo(
    () =>
      searchSimulatorTabs(simulatorTabEntries, deferredQuery.trim(), {
        context: paletteSearchContext
      }),
    [simulatorTabEntries, deferredQuery, paletteSearchContext]
  )
  const workspaceTabEntries = useMemo<SearchableWorkspaceTab[]>(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_WORKSPACE_TAB_ENTRIES
    }
    return buildSearchableWorkspaceTabs({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: allWorktrees,
      repoMap,
      repoMapByHostIdentity: repoByHostIdentity,
      worktreeOrder,
      unifiedTabsByWorktree,
      tabsByWorktree,
      openFiles,
      agentStatusByPaneKey,
      retainedAgentsByPaneKey,
      sleepingAgentSessionsByPaneKey,
      activeGroupIdByWorktree,
      groupsByWorktree,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType,
      activeTabId,
      activeTabIdByWorktree,
      activeFileId,
      activeFileIdByWorktree,
      activeTabTypeByWorktree,
      generatedTitlesEnabled: settings?.tabAutoGenerateTitle === true,
      terminalLayoutsByTabId,
      paneForegroundAgentByPaneKey
    })
  }, [
    paletteStatusInputsActive,
    activeFileId,
    activeFileIdByWorktree,
    activeGroupIdByWorktree,
    activeTabId,
    activeTabIdByWorktree,
    activeTabType,
    activeTabTypeByWorktree,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    allWorktrees,
    agentStatusByPaneKey,
    browserSortedWorktrees,
    groupsByWorktree,
    openFiles,
    repoMap,
    repoByHostIdentity,
    retainedAgentsByPaneKey,
    settings?.tabAutoGenerateTitle,
    sleepingAgentSessionsByPaneKey,
    paneForegroundAgentByPaneKey,
    tabsByWorktree,
    terminalLayoutsByTabId,
    unifiedTabsByWorktree,
    worktreeOrder
  ])
  const workspaceTabMatches = useMemo(
    () =>
      searchWorkspaceTabs(workspaceTabEntries, deferredQuery.trim(), {
        context: paletteSearchContext
      }),
    [workspaceTabEntries, deferredQuery, paletteSearchContext]
  )
  const worktreeItems = useMemo<WorktreePaletteItem[]>(() => {
    const items = worktreeMatches
      .map((match) => {
        const worktree = resolveWorktree(match.worktreeId, match.worktreeHostId)
        return worktree
          ? {
              id: encodePaletteIdentity(['worktree', getPaletteWorktreeIdentity(worktree)]),
              type: 'worktree' as const,
              match,
              worktree
            }
          : null
      })
      .filter((item): item is WorktreePaletteItem => item !== null)
    if (!hasQuery) {
      return items
    }
    const orderByIdentity = new Map(
      items.map((item, index) => [getPaletteWorktreeIdentity(item.worktree), index])
    )
    return items.sort((left, right) =>
      comparePaletteRankedItems(
        {
          rank: left.match.rank,
          order: orderByIdentity.get(getPaletteWorktreeIdentity(left.worktree)) ?? 0,
          identity: left.id,
          activity: left.match.activity
        },
        {
          rank: right.match.rank,
          order: orderByIdentity.get(getPaletteWorktreeIdentity(right.worktree)) ?? 0,
          identity: right.id,
          activity: right.match.activity
        }
      )
    )
  }, [hasQuery, resolveWorktree, worktreeMatches])
  const browserItems = useMemo<BrowserPaletteItem[]>(
    () => buildBrowserPaletteItems(browserMatches),
    [browserMatches]
  )
  const simulatorItems = useMemo<SimulatorPaletteItem[]>(
    () => buildSimulatorPaletteItems(simulatorMatches),
    [simulatorMatches]
  )
  const workspaceTabItems = useMemo<WorkspaceTabPaletteItem[]>(
    () => buildWorkspaceTabPaletteItems(workspaceTabMatches),
    [workspaceTabMatches]
  )
  const openTabItems = useMemo<OpenTabPaletteItem[]>(
    () => buildOpenTabPaletteItems({ browserItems, simulatorItems, workspaceTabItems }),
    [browserItems, simulatorItems, workspaceTabItems]
  )

  return {
    browserPageEntries,
    simulatorTabEntries,
    workspaceTabEntries,
    worktreeItems,
    browserItems,
    simulatorItems,
    workspaceTabItems,
    openTabItems
  }
}

export type WorktreeJumpPaletteOpenTabs = ReturnType<typeof useWorktreeJumpPaletteOpenTabs>
