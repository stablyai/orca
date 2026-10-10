import React from 'react'
import { canToggleNativeChat } from '../native-chat/native-chat-availability'
import { resolveNativeChatTabAgentEvidence } from './native-chat-tab-agent-evidence'
import type { DropIndicator } from './drop-indicator'
import {
  resolveEditorTabGitStatus,
  resolveTerminalItemTab,
  type TabBarItem
} from './tab-bar-item-model'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import TabBarItemRow from './TabBarItemRow'

export type TabBarItemSurfaceProps = Pick<
  TabBarProps,
  | 'worktreeId'
  | 'activeTabId'
  | 'activeFileId'
  | 'activeBrowserTabId'
  | 'activeSimulatorTabId'
  | 'activeTabType'
  | 'expandedPaneByTabId'
>

export type TabBarItemSurfaceRuntime = Pick<
  TabBarRuntimeModel,
  | 'resolvedGroupId'
  | 'generatedTabTitlesEnabled'
  | 'unifiedTabByVisibleId'
  | 'tabAgentTypesByTabId'
  | 'nativeChatTabWideFallbackUnsafeTabsById'
  | 'nativeChatTranscriptIsLocalReadable'
  | 'managedBrowserCreationEnabled'
  | 'statusByRelativePath'
>

export function renderTabBarItems({
  items,
  props,
  runtime,
  actions,
  dropIndicatorByVisibleId,
  includeTopTabBorder,
  activeClientHostedBrowserRowId
}: {
  items: TabBarItem[]
  props: TabBarItemSurfaceProps
  runtime: TabBarItemSurfaceRuntime
  actions: TabBarItemActions
  dropIndicatorByVisibleId: Map<string, DropIndicator>
  includeTopTabBorder: boolean
  activeClientHostedBrowserRowId: string | null
}): React.ReactNode[] {
  const {
    worktreeId,
    activeTabId,
    activeFileId,
    activeBrowserTabId,
    activeSimulatorTabId,
    activeTabType,
    expandedPaneByTabId
  } = props
  const {
    resolvedGroupId,
    generatedTabTitlesEnabled,
    unifiedTabByVisibleId,
    tabAgentTypesByTabId,
    nativeChatTabWideFallbackUnsafeTabsById,
    nativeChatTranscriptIsLocalReadable,
    managedBrowserCreationEnabled,
    statusByRelativePath
  } = runtime

  // A selected client-hosted row covers the pane, so the tab it covers must stop looking active —
  // the group's own activeTabId never moves for it, and two underlines would show at once.
  const clientHostedRowOwnsActiveState = activeClientHostedBrowserRowId !== null

  function isActiveItem(item: TabBarItem): boolean {
    if (clientHostedRowOwnsActiveState) {
      return false
    }
    if (item.type === 'terminal') {
      return (
        (activeTabType === 'terminal' || activeTabType === 'simulator') && item.id === activeTabId
      )
    }
    if (item.type === 'browser') {
      return activeTabType === 'browser' && activeBrowserTabId === item.id
    }
    if (item.type === 'simulator') {
      return activeTabType === 'simulator' && item.id === activeSimulatorTabId
    }
    if (item.type === 'agent-session') {
      return activeTabType === 'agent-session' && item.id === activeTabId
    }
    return (activeTabType === 'editor' || activeTabType === 'simulator') && activeFileId === item.id
  }

  return items.map((item, index) => {
    let canToggleViewMode = false
    let isChatView = false
    let viewModeTabId: string | undefined
    if (item.type === 'terminal') {
      const terminalTab = resolveTerminalItemTab(item.data, generatedTabTitlesEnabled)
      const unifiedTabForItem = unifiedTabByVisibleId.get(item.id)
      // Carry the agent *identity* (not just "an agent exists") so the native-chat gate can reject agents like Grok.
      const resolvedAgent = resolveNativeChatTabAgentEvidence(terminalTab, unifiedTabForItem)
      // Key the live-agent lookup by the backing terminal tab id: agent-status pane keys use it, not the unified tab id.
      const detectedAgent = tabAgentTypesByTabId[terminalTab.id] ?? null
      const tabWideFallbackSafe = nativeChatTabWideFallbackUnsafeTabsById[terminalTab.id] !== true
      canToggleViewMode =
        unifiedTabForItem !== undefined &&
        canToggleNativeChat({
          contentType: 'terminal',
          launchAgent: tabWideFallbackSafe ? terminalTab.launchAgent : null,
          detectedAgent,
          resolvedAgent: tabWideFallbackSafe ? resolvedAgent : null,
          nativeChatTranscriptIsLocalReadable,
          isChatViewMode: unifiedTabForItem.viewMode === 'chat'
        })
      isChatView = unifiedTabForItem?.viewMode === 'chat'
      viewModeTabId = unifiedTabForItem?.id
    }
    return (
      <TabBarItemRow
        key={item.id}
        item={item}
        actions={actions}
        worktreeId={worktreeId}
        groupId={resolvedGroupId}
        generatedTabTitlesEnabled={generatedTabTitlesEnabled}
        tabCount={items.length}
        hasTabsToLeft={index > 0}
        hasTabsToRight={index < items.length - 1}
        isActive={isActiveItem(item)}
        isExpanded={item.type === 'terminal' && expandedPaneByTabId[item.id] === true}
        dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
        includeTopTabBorder={includeTopTabBorder}
        canToggleViewMode={canToggleViewMode}
        isChatView={isChatView}
        viewModeTabId={viewModeTabId}
        canDuplicate={item.type === 'browser' && managedBrowserCreationEnabled}
        gitStatus={
          item.type === 'editor'
            ? resolveEditorTabGitStatus(item.data, statusByRelativePath)
            : null
        }
      />
    )
  })
}
