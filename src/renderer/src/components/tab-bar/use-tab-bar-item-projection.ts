import { useMemo } from 'react'
import type { GitFileStatus } from '../../../../shared/git-status-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TabBarProps } from './tab-bar-props'
import {
  buildOrderedTabItems,
  buildTabDropIndicators,
  buildTabStripLayoutKey,
  findActiveVisibleTabId,
  type TabBarItem
} from './tab-bar-item-model'
import type { DropIndicator } from './drop-indicator'

export type TabBarItemProjection = {
  orderedItems: TabBarItem[]
  sortableIds: string[]
  dropIndicatorByVisibleId: Map<string, DropIndicator>
  activeVisibleTabId: string | null
  tabStripLayoutKey: string
}

export function useTabBarItemProjection({
  props,
  resolvedGroupId,
  unifiedTabs,
  unifiedTabByVisibleId,
  generatedTabTitlesEnabled,
  statusByRelativePath
}: {
  props: TabBarProps
  resolvedGroupId: string
  unifiedTabs: readonly Tab[]
  unifiedTabByVisibleId: Map<string, Tab>
  generatedTabTitlesEnabled: boolean
  statusByRelativePath: Map<string, GitFileStatus>
}): TabBarItemProjection {
  const {
    tabs,
    editorFiles,
    browserTabs,
    agentSessionTabs,
    tabBarOrder,
    hoveredTabInsertion,
    activeTabId,
    activeFileId,
    activeBrowserTabId,
    activeSimulatorTabId,
    activeTabType,
    expandedPaneByTabId
  } = props
  const terminalMap = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs])
  const editorMap = useMemo(
    () => new Map((editorFiles ?? []).map((file) => [file.tabId ?? file.id, file])),
    [editorFiles]
  )
  const browserMap = useMemo(
    () => new Map((browserTabs ?? []).map((tab) => [tab.id, tab])),
    [browserTabs]
  )
  const agentSessionMap = useMemo(
    () => new Map((agentSessionTabs ?? []).map((tab) => [tab.id, tab])),
    [agentSessionTabs]
  )
  const terminalIds = useMemo(() => tabs.map((tab) => tab.id), [tabs])
  const editorFileIds = useMemo(
    () => editorFiles?.map((file) => file.tabId ?? file.id) ?? [],
    [editorFiles]
  )
  const browserTabIds = useMemo(() => browserTabs?.map((tab) => tab.id) ?? [], [browserTabs])
  const simulatorTabIds = useMemo(
    () =>
      unifiedTabs
        .filter((tab) => tab.groupId === resolvedGroupId && tab.contentType === 'simulator')
        .map((tab) => tab.id),
    [unifiedTabs, resolvedGroupId]
  )
  const agentSessionTabIds = useMemo(
    () => agentSessionTabs?.map((tab) => tab.id) ?? [],
    [agentSessionTabs]
  )
  const orderedItems = useMemo(
    () =>
      buildOrderedTabItems({
        tabBarOrder,
        terminalIds,
        editorFileIds,
        browserTabIds,
        simulatorTabIds,
        agentSessionTabIds,
        terminalMap,
        editorMap,
        browserMap,
        agentSessionMap,
        unifiedTabByVisibleId
      }),
    [
      tabBarOrder,
      terminalIds,
      editorFileIds,
      browserTabIds,
      simulatorTabIds,
      agentSessionTabIds,
      terminalMap,
      editorMap,
      browserMap,
      agentSessionMap,
      unifiedTabByVisibleId
    ]
  )
  const sortableIds = useMemo(() => orderedItems.map((item) => item.id), [orderedItems])
  const activeIndicator =
    hoveredTabInsertion?.groupId === resolvedGroupId ? hoveredTabInsertion : null
  const dropIndicatorByVisibleId = useMemo(
    () => buildTabDropIndicators(orderedItems, activeIndicator),
    [activeIndicator, orderedItems]
  )
  const activeVisibleTabId = useMemo(
    () =>
      findActiveVisibleTabId(orderedItems, {
        activeTabId,
        activeFileId,
        activeBrowserTabId,
        activeSimulatorTabId,
        activeTabType
      }),
    [
      activeBrowserTabId,
      activeFileId,
      activeSimulatorTabId,
      activeTabId,
      activeTabType,
      orderedItems
    ]
  )
  const tabStripLayoutKey = useMemo(
    () =>
      buildTabStripLayoutKey(
        orderedItems,
        generatedTabTitlesEnabled,
        expandedPaneByTabId,
        statusByRelativePath
      ),
    [expandedPaneByTabId, generatedTabTitlesEnabled, orderedItems, statusByRelativePath]
  )

  return {
    orderedItems,
    sortableIds,
    dropIndicatorByVisibleId,
    activeVisibleTabId,
    tabStripLayoutKey
  }
}
