import { useMemo, useState } from 'react'
import type { GitFileStatus } from '../../../../shared/git-status-types'
import type { Tab, TabCluster, TabGroup } from '../../../../shared/tab-types'
import type { TabBarProps } from './tab-bar-props'
import {
  buildOrderedTabItems,
  buildTabDropIndicators,
  buildTabStripLayoutKey,
  findActiveVisibleTabId,
  type TabBarItem
} from './tab-bar-item-model'
import type { DropIndicator } from './drop-indicator'
import { buildTabBarStripItems, type TabBarStripItem } from './tab-bar-cluster-items'
import { sameStringArray } from '@/runtime/web-session-tabs-sync/state-equality-core'

export type TabBarItemProjection = {
  orderedItems: TabBarItem[]
  stripItems: TabBarStripItem[]
  visibleItems: TabBarItem[]
  clusterByUnifiedTabId: Map<string, TabCluster>
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
  statusByRelativePath,
  group = null
}: {
  props: TabBarProps
  resolvedGroupId: string
  unifiedTabs: readonly Tab[]
  unifiedTabByVisibleId: Map<string, Tab>
  generatedTabTitlesEnabled: boolean
  statusByRelativePath: Map<string, GitFileStatus>
  group?: TabGroup | null
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
  const clusterByUnifiedTabId = useMemo(() => {
    const lookup = new Map<string, TabCluster>()
    for (const cluster of group?.tabClusters ?? []) {
      for (const tabId of cluster.tabIds) {
        lookup.set(tabId, cluster)
      }
    }
    return lookup
  }, [group?.tabClusters])
  const stripItems = useMemo(
    () => buildTabBarStripItems(orderedItems, group, clusterByUnifiedTabId),
    [orderedItems, group, clusterByUnifiedTabId]
  )
  const visibleItems = useMemo(
    () => stripItems.filter((item): item is TabBarItem => item.type !== 'cluster'),
    [stripItems]
  )
  const stripIds = useMemo(() => stripItems.map((item) => item.id), [stripItems])
  // Why: dnd-kit re-renders every tab when this array's identity changes, and the items rebuild on any tab write.
  const [sortableIds, setSortableIds] = useState(stripIds)
  if (!sameStringArray(sortableIds, stripIds)) {
    setSortableIds(stripIds)
  }
  const activeIndicator =
    hoveredTabInsertion?.groupId === resolvedGroupId ? hoveredTabInsertion : null
  const dropIndicatorByVisibleId = useMemo(
    () => buildTabDropIndicators(stripItems, activeIndicator),
    [activeIndicator, stripItems]
  )
  const activeVisibleTabId = useMemo(
    () =>
      findActiveVisibleTabId(visibleItems, {
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
      visibleItems
    ]
  )
  const tabStripLayoutKey = useMemo(
    () =>
      buildTabStripLayoutKey(
        visibleItems,
        generatedTabTitlesEnabled,
        expandedPaneByTabId,
        statusByRelativePath
      ) +
      stripItems
        .filter((item) => item.type === 'cluster')
        .map(
          (item) =>
            `${item.id}:${item.data.name}:${item.data.color}:${item.data.collapsed}:${item.data.tabIds.length}`
        )
        .join('\u001f'),
    [expandedPaneByTabId, generatedTabTitlesEnabled, visibleItems, stripItems, statusByRelativePath]
  )

  return {
    orderedItems,
    stripItems,
    visibleItems,
    clusterByUnifiedTabId,
    sortableIds,
    dropIndicatorByVisibleId,
    activeVisibleTabId,
    tabStripLayoutKey
  }
}
