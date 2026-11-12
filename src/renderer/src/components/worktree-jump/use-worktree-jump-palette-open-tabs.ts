import { useMemo } from 'react'
import { buildSearchableBrowserPages } from '@/lib/browser/palette/browser-palette-page-entries'
import {
  searchBrowserPages,
  type SearchableBrowserPage
} from '@/lib/browser/palette/browser-palette-search'
import {
  buildSearchableSimulatorTabs,
  searchSimulatorTabs
} from '@/lib/simulator/search/simulator-palette-search'
import type { SearchableSimulatorTab } from '@/lib/simulator/search/simulator-palette-search-types'
import '@/lib/workspace/search/tabs/workspace-tab-search-types'
import type { SearchableWorkspaceTab } from '@/lib/workspace/search/tabs/workspace-tab-search-types'
import { buildSearchableWorkspaceTabEntries } from '@/lib/workspace/search/tabs/workspace-tab-palette-entry-builder'

import { searchWorkspaceTabs } from '@/lib/workspace/search/tabs/workspace-tab-palette-results'
import { comparePaletteRankedItems } from '@/lib/workspace/search/palette/cmd-j-section-leadership'
import { getPaletteWorktreeIdentity } from '@/lib/workspace/search/palette-repo-resolution'
import type {
  BrowserPaletteItem,
  OpenTabPaletteItem,
  SimulatorPaletteItem,
  WorkspaceTabPaletteItem,
  WorktreePaletteItem
} from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteOpenTabsInput } from './worktree-jump-palette-open-tabs-input'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import {
  buildBrowserPaletteItems,
  buildOpenTabPaletteItems,
  buildSimulatorPaletteItems,
  buildWorkspaceTabPaletteItems
} from './worktree-jump-palette-open-tab-items'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useStructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-name-observation'
import { useTranslate } from '@/i18n/use-translate'

const EMPTY_BROWSER_PAGE_ENTRIES: SearchableBrowserPage[] = []
const EMPTY_SIMULATOR_TAB_ENTRIES: SearchableSimulatorTab[] = []
const EMPTY_WORKSPACE_TAB_ENTRIES: SearchableWorkspaceTab[] = []

export function useWorktreeJumpPaletteOpenTabs({
  paletteStatusInputsActive,
  browserSortedWorktrees,
  workspaces,
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
  hidesPaletteWorkspace,
  resolveWorktree
}: WorktreeJumpPaletteOpenTabsInput) {
  const t = useTranslate()
  const languageRevision = useUiLanguageRevision()
  const chatNames = useStructuredChatTabNames()
  const browserPageEntries = useMemo<SearchableBrowserPage[]>(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_BROWSER_PAGE_ENTRIES
    }
    return buildSearchableBrowserPages({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: workspaces,
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
    workspaces,
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
      ownershipWorktrees: workspaces,
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
    workspaces,
    browserSortedWorktrees,
    groupsByWorktree,
    repoByHostIdentity,
    repoMap,
    unifiedTabsByWorktree,
    worktreeOrder
  ])
  const simulatorMatches = useMemo(
    () =>
      searchSimulatorTabs(
        simulatorTabEntries,
        deferredQuery.trim(),
        {
          context: paletteSearchContext
        },
        t
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- simulator titles translate the default label.
    [simulatorTabEntries, deferredQuery, paletteSearchContext, languageRevision, t]
  )
  const workspaceTabEntries = useMemo<SearchableWorkspaceTab[]>(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_WORKSPACE_TAB_ENTRIES
    }
    return buildSearchableWorkspaceTabEntries({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: workspaces,
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
      chatNames,
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
    workspaces,
    agentStatusByPaneKey,
    browserSortedWorktrees,
    chatNames,
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
      .filter(
        (item): item is WorktreePaletteItem =>
          item !== null && !hidesPaletteWorkspace?.(item.worktree)
      )
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
  }, [hasQuery, hidesPaletteWorkspace, resolveWorktree, worktreeMatches])
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
