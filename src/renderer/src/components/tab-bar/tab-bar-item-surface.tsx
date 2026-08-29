import React from 'react'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import type { OpenFile } from '../../store/slices/editor'
import SortableTab from './SortableTab'
import EditorFileTab from './EditorFileTab'
import BrowserTab from './BrowserTab'
import type { DropIndicator } from './drop-indicator'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import { getTabDragLabel, type TabBarItem } from './tab-bar-item-model'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import { clearClientHostedBrowserRowSelection } from '@/lib/pane-manager/client-hosted-browser-row-state'

export function renderTabBarItems({
  items,
  props,
  runtime,
  dropIndicatorByVisibleId,
  includeTopTabBorder,
  activeClientHostedBrowserRowId,
  togglePinned
}: {
  items: TabBarItem[]
  props: TabBarProps
  runtime: TabBarRuntimeModel
  dropIndicatorByVisibleId: Map<string, DropIndicator>
  includeTopTabBorder: boolean
  activeClientHostedBrowserRowId: string | null
  togglePinned: (item: TabBarItem) => void
}): React.ReactNode[] {
  const {
    worktreeId,
    activeTabId,
    activeFileId,
    activeBrowserTabId,
    activeSimulatorTabId,
    activeTabType,
    expandedPaneByTabId,
    onActivate,
    onClose,
    onCloseOthers,
    onCloseToRight,
    onCloseToLeft,
    onSetCustomTitle,
    onSetTabColor,
    onTogglePaneExpand,
    onActivateFile,
    onCloseFile,
    onActivateBrowserTab,
    onActivateAgentSession,
    onCloseBrowserTab,
    onDuplicateBrowserTab,
    onCloseAllFiles,
    onMakePreviewFilePermanent
  } = props
  const { resolvedGroupId, generatedTabTitlesEnabled, statusByRelativePath } = runtime

  // A selected client-hosted row covers the pane, so the tab it covers must stop looking active —
  // the group's own activeTabId never moves for it, and two underlines would show at once.
  const clientHostedRowOwnsActiveState = activeClientHostedBrowserRowId !== null

  // Why: this is the strip's single activation fan-out, so retiring a client-hosted placeholder
  // here covers every row kind — including re-clicking the tab that was already active, which the
  // group's activeTabId never moves for.
  function activateRealTab<TArg>(activate: ((arg: TArg) => void) | undefined): (arg: TArg) => void {
    return (arg) => {
      clearClientHostedBrowserRowSelection()
      activate?.(arg)
    }
  }

  return items.map((item, index) => {
    const dragData: TabDragItemData = {
      kind: 'tab',
      worktreeId,
      groupId: resolvedGroupId,
      unifiedTabId: item.unifiedTabId,
      visibleTabId: item.id,
      tabType: item.type,
      label: getTabDragLabel(item, generatedTabTitlesEnabled),
      iconPath: item.type === 'editor' ? item.data.filePath : undefined,
      color: item.type === 'terminal' ? (item.data.color ?? null) : null
    }
    if (item.type === 'terminal') {
      const terminalTab = {
        ...item.data,
        title: resolveTerminalTabTitle(item.data, generatedTabTitlesEnabled, item.data.title)
      }
      return (
        <SortableTab
          key={item.id}
          tab={terminalTab}
          unifiedTabId={item.unifiedTabId}
          groupId={resolvedGroupId}
          tabCount={items.length}
          hasTabsToRight={index < items.length - 1}
          hasTabsToLeft={index > 0}
          isActive={
            !clientHostedRowOwnsActiveState &&
            (activeTabType === 'terminal' || activeTabType === 'simulator') &&
            item.id === activeTabId
          }
          isPinned={item.isPinned}
          isExpanded={expandedPaneByTabId[item.id] === true}
          onActivate={activateRealTab(onActivate)}
          onClose={onClose}
          onCloseOthers={onCloseOthers}
          onCloseToRight={onCloseToRight}
          onCloseToLeft={onCloseToLeft}
          onSetCustomTitle={onSetCustomTitle}
          onSetTabColor={onSetTabColor}
          onTogglePin={() => togglePinned(item)}
          onToggleExpand={onTogglePaneExpand}
          dragData={dragData}
          dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
          includeTopTabBorder={includeTopTabBorder}
        />
      )
    }
    if (item.type === 'browser') {
      return (
        <BrowserTab
          key={item.id}
          tab={item.data}
          isActive={
            !clientHostedRowOwnsActiveState &&
            activeTabType === 'browser' &&
            activeBrowserTabId === item.id
          }
          isPinned={item.isPinned}
          hasTabsToRight={index < items.length - 1}
          hasTabsToLeft={index > 0}
          tabCount={items.length}
          onActivate={() => activateRealTab(onActivateBrowserTab)(item.id)}
          onClose={() => onCloseBrowserTab?.(item.id)}
          onCloseOthers={() => onCloseOthers(item.id)}
          onCloseToRight={() => onCloseToRight(item.id)}
          onCloseToLeft={() => onCloseToLeft(item.id)}
          onDuplicate={
            runtime.managedBrowserCreationEnabled
              ? () => onDuplicateBrowserTab?.(item.id)
              : undefined
          }
          onTogglePin={() => togglePinned(item)}
          dragData={dragData}
          dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
          includeTopTabBorder={includeTopTabBorder}
        />
      )
    }
    if (item.type === 'simulator') {
      const simulatorLabel = item.data.label || 'Mobile Emulator'
      const simulatorFile: OpenFile & { tabId: string } = {
        id: item.id,
        tabId: item.id,
        filePath: simulatorLabel,
        relativePath: simulatorLabel,
        worktreeId,
        language: 'simulator',
        isPreview: false,
        isDirty: false,
        mode: 'edit'
      }
      return (
        <EditorFileTab
          key={item.id}
          file={simulatorFile}
          isActive={
            !clientHostedRowOwnsActiveState &&
            activeTabType === 'simulator' &&
            item.id === activeSimulatorTabId
          }
          isPinned={item.isPinned}
          hasTabsToRight={index < items.length - 1}
          hasTabsToLeft={index > 0}
          tabCount={items.length}
          statusByRelativePath={statusByRelativePath}
          onActivate={() => activateRealTab(onActivateFile)(item.id)}
          onClose={() => onCloseFile?.(item.id)}
          onCloseOthers={() => onCloseOthers(item.id)}
          onCloseToRight={() => onCloseToRight(item.id)}
          onCloseToLeft={() => onCloseToLeft(item.id)}
          onCloseAll={() => onCloseAllFiles?.()}
          onMakePermanent={() => {}}
          onTogglePin={() => togglePinned(item)}
          dragData={dragData}
          dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
          includeTopTabBorder={includeTopTabBorder}
        />
      )
    }
    if (item.type === 'agent-session') {
      const structuredTab: TerminalTab = {
        id: item.id,
        ptyId: null,
        worktreeId,
        title: item.data.label,
        customTitle: item.data.customLabel,
        color: item.data.color,
        sortOrder: item.data.sortOrder,
        createdAt: item.data.createdAt,
        ...(isAgentSessionHandleProvider(item.data.agentSessionAgent)
          ? { launchAgent: item.data.agentSessionAgent as TuiAgent }
          : {})
      }
      return (
        <SortableTab
          key={item.id}
          tab={structuredTab}
          unifiedTabId={item.unifiedTabId}
          groupId={resolvedGroupId}
          tabCount={items.length}
          hasTabsToRight={index < items.length - 1}
          hasTabsToLeft={index > 0}
          isActive={
            !clientHostedRowOwnsActiveState &&
            activeTabType === 'agent-session' &&
            item.id === activeTabId
          }
          isPinned={item.isPinned}
          isExpanded={false}
          onActivate={() => activateRealTab(onActivateAgentSession)(item.id)}
          onClose={() => onClose(item.id)}
          onCloseOthers={() => onCloseOthers(item.id)}
          onCloseToRight={() => onCloseToRight(item.id)}
          onCloseToLeft={() => onCloseToLeft(item.id)}
          onSetCustomTitle={onSetCustomTitle}
          onSetTabColor={onSetTabColor}
          onTogglePin={() => togglePinned(item)}
          onToggleExpand={() => {}}
          dragData={dragData}
          dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
          includeTopTabBorder={includeTopTabBorder}
        />
      )
    }
    return (
      <EditorFileTab
        key={item.id}
        file={item.data}
        isActive={
          !clientHostedRowOwnsActiveState &&
          (activeTabType === 'editor' || activeTabType === 'simulator') &&
          activeFileId === item.id
        }
        isPinned={item.isPinned}
        hasTabsToRight={index < items.length - 1}
        hasTabsToLeft={index > 0}
        tabCount={items.length}
        statusByRelativePath={statusByRelativePath}
        onActivate={() => activateRealTab(onActivateFile)(item.id)}
        onClose={() => onCloseFile?.(item.id)}
        onCloseOthers={() => onCloseOthers(item.id)}
        onCloseToRight={() => onCloseToRight(item.id)}
        onCloseToLeft={() => onCloseToLeft(item.id)}
        onCloseAll={() => onCloseAllFiles?.()}
        onMakePermanent={() => onMakePreviewFilePermanent?.(item.data.id, item.data.tabId)}
        onTogglePin={() => togglePinned(item)}
        dragData={dragData}
        dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
        includeTopTabBorder={includeTopTabBorder}
      />
    )
  })
}
