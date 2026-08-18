import { useMemo } from 'react'
import type { GitFileStatus } from '../../../../shared/git-status-types'
import type { TabFolderGroup } from '../../../../shared/tab-folder-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TabBarProps } from './tab-bar-props'
import {
  buildOrderedTabItems,
  buildTabDropIndicators,
  buildTabStripLayoutKey,
  findActiveVisibleTabId,
  type TabBarItem
} from './tab-bar-item-model'
import {
  projectTabStripEntries,
  tabStripEntriesLayoutKey,
  visibleSortableIdsFromStripEntries,
  type TabStripEntry
} from './tab-folder-strip-entries'
import type { DropIndicator } from './drop-indicator'

export type TabBarItemProjection = {
  orderedItems: TabBarItem[]
  stripEntries: TabStripEntry[]
  sortableIds: string[]
  dropIndicatorByVisibleId: Map<string, DropIndicator>
  activeVisibleTabId: string | null
  tabStripLayoutKey: string
}

export function useTabBarItemProjection({
  props,
  resolvedGroupId,
  unifiedTabs,
  folderGroups,
  unifiedTabByVisibleId,
  generatedTabTitlesEnabled,
  statusByRelativePath
}: {
  props: TabBarProps
  resolvedGroupId: string
  unifiedTabs: readonly Tab[]
  folderGroups: readonly TabFolderGroup[]
  unifiedTabByVisibleId: Map<string, Tab>
  generatedTabTitlesEnabled: boolean
  statusByRelativePath: Map<string, GitFileStatus>
}): TabBarItemProjection {
  const {
    tabs,
    editorFiles,
    browserTabs,
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
  const orderedItems = useMemo(
    () =>
      buildOrderedTabItems({
        tabBarOrder,
        terminalIds,
        editorFileIds,
        browserTabIds,
        simulatorTabIds,
        terminalMap,
        editorMap,
        browserMap,
        unifiedTabByVisibleId
      }),
    [
      tabBarOrder,
      terminalIds,
      editorFileIds,
      browserTabIds,
      simulatorTabIds,
      terminalMap,
      editorMap,
      browserMap,
      unifiedTabByVisibleId
    ]
  )
  const stripEntries = useMemo(
    () => projectTabStripEntries(orderedItems, folderGroups, unifiedTabs, resolvedGroupId),
    [folderGroups, orderedItems, resolvedGroupId, unifiedTabs]
  )
  const sortableIds = useMemo(
    () => visibleSortableIdsFromStripEntries(stripEntries),
    [stripEntries]
  )
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
      [
        buildTabStripLayoutKey(
          orderedItems,
          generatedTabTitlesEnabled,
          expandedPaneByTabId,
          statusByRelativePath
        ),
        // Why: collapse/expand changes stripEntries without changing orderedItems.
        tabStripEntriesLayoutKey(stripEntries)
      ].join('\u001e'),
    [
      expandedPaneByTabId,
      generatedTabTitlesEnabled,
      orderedItems,
      statusByRelativePath,
      stripEntries
    ]
  )

  return {
    orderedItems,
    stripEntries,
    sortableIds,
    dropIndicatorByVisibleId,
    activeVisibleTabId,
    tabStripLayoutKey
  }
}
