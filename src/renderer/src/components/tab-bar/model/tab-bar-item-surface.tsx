import React from 'react'
import { canToggleNativeChat } from '../../../../../shared/native-chat/native-chat-availability'
import { resolveNativeChatTabAgentEvidence } from '../session-actions/native-chat-tab-agent-evidence'
import type { DropIndicator } from '../strip/drop-indicator'
import {
  resolveEditorTabGitStatus,
  resolveTerminalItemTab,
  type TabBarItem
} from './tab-bar-item-model'
import type { TabBarProps } from '../tab-bar-props'
import type { TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import TabBarItemRow from './TabBarItemRow'
import { TAB_STRIP_WINDOW_SLOT_PX, type TabStripSegment } from '../strip/tab-strip-window'

export type TabBarItemSurfaceProps = Pick<
  TabBarProps,
  | 'worktreeId'
  | 'activeTabId'
  | 'activeFileId'
  | 'activeBrowserTabId'
  | 'activeSimulatorTabId'
  | 'activeTabType'
  | 'expandedPaneByTabId'
  | 'onCloseSplitPane'
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
  activeClientHostedBrowserRowId,
  segments,
  itemOffset = 0
}: {
  items: TabBarItem[]
  /** Mounted runs of `items` from `itemOffset` on; gaps render as fixed-width spacers. */
  segments: readonly TabStripSegment[]
  /** Items before the strip, such as a pinned Home: segment indices start after them. */
  itemOffset?: number
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

  // Client-hosted selection leaves group activeTabId intact; suppress the covered tab’s underline to avoid two active slots.
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
    if (item.type === 'agent-session' || item.type === 'room') {
      return activeTabType === 'agent-session' && item.id === activeTabId
    }
    return (activeTabType === 'editor' || activeTabType === 'simulator') && activeFileId === item.id
  }

  function renderRow(item: TabBarItem, index: number): React.ReactNode {
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
        canCloseSplitPane={props.onCloseSplitPane !== undefined}
        gitStatus={
          item.type === 'editor' ? resolveEditorTabGitStatus(item.data, statusByRelativePath) : null
        }
      />
    )
  }

  const rows: React.ReactNode[] = []
  for (const segment of segments) {
    if (segment.kind === 'gap') {
      rows.push(
        <div
          key={`tab-strip-gap-${segment.start}`}
          aria-hidden
          data-tab-strip-gap=""
          data-tab-strip-gap-start={segment.start}
          data-tab-strip-gap-end={segment.end}
          className="flex-none"
          style={{ width: (segment.end - segment.start) * TAB_STRIP_WINDOW_SLOT_PX }}
        />
      )
      continue
    }
    for (let index = segment.start + itemOffset; index < segment.end + itemOffset; index++) {
      rows.push(renderRow(items[index], index))
    }
  }
  return rows
}
