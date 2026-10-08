import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { shallow } from 'zustand/shallow'
import type { GitFileStatus } from '../../../../shared/git-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { OpenFile } from '../../store/slices/editor'
import SortableTab from './SortableTab'
import EditorFileTab from './EditorFileTab'
import BrowserTab from './BrowserTab'
import type { DropIndicator } from './drop-indicator'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import { getTabDragLabel, resolveTerminalItemTab, type TabBarItem } from './tab-bar-item-model'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import { useStructuredChatTabConversationName } from '@/runtime/structured-conversation-name'

// Why only values and `actions`: anything a tab draws must be a compared prop, or a skipped render shows it stale.
type TabBarItemRowProps = {
  item: TabBarItem
  actions: TabBarItemActions
  worktreeId: string
  groupId: string
  generatedTabTitlesEnabled: boolean
  tabCount: number
  hasTabsToLeft: boolean
  hasTabsToRight: boolean
  isActive: boolean
  isExpanded: boolean
  dropIndicator: DropIndicator
  includeTopTabBorder: boolean
  canToggleViewMode: boolean
  isChatView: boolean
  /** Unified tab whose view mode the terminal tab toggles; absent when it has none. */
  viewModeTabId: string | undefined
  canDuplicate: boolean
  /** This editor tab's own status, so a git status write re-renders only the tabs it changed. */
  gitStatus: GitFileStatus | null
}

function TabBarItemRow({
  item,
  actions,
  worktreeId,
  groupId,
  generatedTabTitlesEnabled,
  tabCount,
  hasTabsToLeft,
  hasTabsToRight,
  isActive,
  isExpanded,
  dropIndicator,
  includeTopTabBorder,
  canToggleViewMode,
  isChatView,
  viewModeTabId,
  canDuplicate,
  gitStatus
}: TabBarItemRowProps): React.JSX.Element {
  // Why: the tabs' labels come from `translate()`, which a skipped render would leave in the old language.
  useTranslation()
  const conversationName = useStructuredChatTabConversationName(
    item.type === 'agent-session' ? item.data : undefined
  )
  const dragData: TabDragItemData = {
    kind: 'tab',
    worktreeId,
    groupId,
    unifiedTabId: item.unifiedTabId,
    visibleTabId: item.id,
    tabType: item.type,
    label: getTabDragLabel(item, generatedTabTitlesEnabled),
    iconPath: item.type === 'editor' ? item.data.filePath : undefined,
    color: item.type === 'terminal' ? (item.data.color ?? null) : null
  }
  const shared = {
    isActive,
    isPinned: item.isPinned,
    hasTabsToRight,
    hasTabsToLeft,
    tabCount,
    onTogglePin: () => actions.togglePinned(item),
    dragData,
    dropIndicator,
    includeTopTabBorder
  }
  const sortableTabProps = {
    ...shared,
    unifiedTabId: item.unifiedTabId,
    groupId,
    onClose: actions.close,
    onCloseOthers: actions.closeOthers,
    onCloseToRight: actions.closeToRight,
    onCloseToLeft: actions.closeToLeft,
    onSetCustomTitle: actions.setCustomTitle,
    onSetTabColor: actions.setTabColor
  }
  if (item.type === 'terminal') {
    return (
      <SortableTab
        {...sortableTabProps}
        tab={resolveTerminalItemTab(item.data, generatedTabTitlesEnabled)}
        canToggleViewMode={canToggleViewMode}
        isChatView={isChatView}
        onToggleViewMode={viewModeTabId ? () => actions.toggleViewMode(viewModeTabId) : undefined}
        isExpanded={isExpanded}
        onActivate={actions.activateTerminal}
        onToggleExpand={actions.togglePaneExpand}
      />
    )
  }
  if (item.type === 'agent-session') {
    const structuredTab: TerminalTab = {
      id: item.id,
      ptyId: null,
      worktreeId,
      title: conversationName ?? item.data.label,
      customTitle: item.data.customLabel,
      color: item.data.color,
      sortOrder: item.data.sortOrder,
      createdAt: item.data.createdAt,
      ...(isTuiAgent(item.data.agentSessionAgent)
        ? { launchAgent: item.data.agentSessionAgent }
        : {})
    }
    return (
      <SortableTab
        {...sortableTabProps}
        tab={structuredTab}
        isExpanded={false}
        onActivate={actions.activateAgentSession}
        onToggleExpand={() => {}}
        canSplitTerminal={false}
      />
    )
  }
  const closeScope = {
    onCloseOthers: () => actions.closeOthers(item.id),
    onCloseToRight: () => actions.closeToRight(item.id),
    onCloseToLeft: () => actions.closeToLeft(item.id)
  }
  if (item.type === 'browser') {
    return (
      <BrowserTab
        {...shared}
        {...closeScope}
        tab={item.data}
        onActivate={() => actions.activateBrowserTab(item.id)}
        onClose={() => actions.closeBrowserTab(item.id)}
        onDuplicate={
          canDuplicate ? () => actions.duplicateBrowserTab(item.id, item.unifiedTabId) : undefined
        }
      />
    )
  }
  const fileTabProps = {
    ...shared,
    ...closeScope,
    gitStatus,
    onActivate: () => actions.activateFile(item.id),
    onClose: () => actions.closeFile(item.id),
    onCloseAll: actions.closeAllFiles
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
    return <EditorFileTab {...fileTabProps} file={simulatorFile} onMakePermanent={() => {}} />
  }
  return (
    <EditorFileTab
      {...fileTabProps}
      file={item.data}
      onMakePermanent={() => actions.makePreviewFilePermanent(item.data.id, item.data.tabId)}
    />
  )
}

// Why field-by-field: the strip rebuilds every `item` and its `data` on any tab write, so identity never survives.
function sameTabBarItemRowProps(previous: TabBarItemRowProps, next: TabBarItemRowProps): boolean {
  const { item: previousItem, ...previousRest } = previous
  const { item: nextItem, ...nextRest } = next
  const { data: previousData, ...previousIdentity } = previousItem
  const { data: nextData, ...nextIdentity } = nextItem
  return (
    shallow(previousRest, nextRest) &&
    shallow(previousIdentity, nextIdentity) &&
    shallow(previousData, nextData)
  )
}

export default memo(TabBarItemRow, sameTabBarItemRowProps)
