import { useStructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-name-observation'
import { useMemo, useState } from 'react'
import type { GitFileStatus } from '../../../../../shared/git/status/git-status-types'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TabBarProps } from '../tab-bar-props'
import {
  buildOrderedTabItems,
  buildTabDropIndicators,
  buildTabStripLayoutKey,
  findActiveVisibleTabId,
  type TabBarItem
} from './tab-bar-item-model'
import type { DropIndicator } from '../strip/drop-indicator'
import type { HoveredTabInsertion } from '../../tab-group/drag/tab-insertion'
import { sameStringArray } from '@/runtime/web-session-tabs-sync/snapshots/state-equality-core'

export type TabBarItemProjection = {
  orderedItems: TabBarItem[]
  sortableIds: string[]
  dropIndicatorByVisibleId: Map<string, DropIndicator>
  hoveredInsertion: HoveredTabInsertion | null
  activeVisibleTabId: string | null
  /** The active item's unified tab id; resolved here so strip re-renders don't search every tab. */
  activeUnifiedTabId: string | null
  tabStripLayoutKey: string
  sideChatOnly?: boolean
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
  const roomTabIds = useMemo(
    () =>
      unifiedTabs
        .filter((tab) => tab.groupId === resolvedGroupId && tab.contentType === 'room')
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
        roomTabIds,
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
      roomTabIds,
      agentSessionTabIds,
      terminalMap,
      editorMap,
      browserMap,
      agentSessionMap,
      unifiedTabByVisibleId
    ]
  )
  const orderedIds = useMemo(() => orderedItems.map((item) => item.id), [orderedItems])
  // Why: dnd-kit re-renders every tab when this array's identity changes, and the items rebuild on any tab write.
  const [sortableIds, setSortableIds] = useState(orderedIds)
  // Compare once per rebuilt id list: a windowed strip re-renders on scroll without any tab change.
  const [comparedIds, setComparedIds] = useState(orderedIds)
  if (comparedIds !== orderedIds) {
    setComparedIds(orderedIds)
    if (!sameStringArray(sortableIds, orderedIds)) {
      setSortableIds(orderedIds)
    }
  }
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
  const activeUnifiedTabId = useMemo(
    () => orderedItems.find((item) => item.id === activeVisibleTabId)?.unifiedTabId ?? null,
    [activeVisibleTabId, orderedItems]
  )
  const chatNames = useStructuredChatTabNames()
  const tabStripLayoutKey = useMemo(
    () =>
      buildTabStripLayoutKey(
        orderedItems,
        generatedTabTitlesEnabled,
        expandedPaneByTabId,
        statusByRelativePath,
        chatNames
      ),
    [expandedPaneByTabId, generatedTabTitlesEnabled, orderedItems, statusByRelativePath, chatNames]
  )

  return {
    orderedItems,
    sortableIds,
    dropIndicatorByVisibleId,
    hoveredInsertion: activeIndicator,
    activeVisibleTabId,
    activeUnifiedTabId,
    tabStripLayoutKey,
    sideChatOnly:
      orderedItems.length > 0 &&
      orderedItems.every(
        (item) => item.type === 'agent-session' && chatNames.get(item.data)?.sideChat === true
      )
  }
}
