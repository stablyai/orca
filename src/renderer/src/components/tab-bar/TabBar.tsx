import React, { useCallback, useMemo } from 'react'
import { useTabStripOverflowNavigation } from './strip/tab-strip-overflow-navigation'
import { useTabStripDragScrollHandlers } from './strip/tab-strip-drag-scroll'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarItem } from './model/tab-bar-item-model'
import { useTabBarRuntimeModel } from './model/use-tab-bar-runtime-model'
import { useTabBarCreateMenuController } from './create-menu/use-tab-bar-create-menu-controller'
import { usePluginNewFileMenuOptions } from './create-menu/use-plugin-new-file-menu-options'
import { useTabBarItemProjection } from './model/use-tab-bar-item-projection'
import { renderTabBarSurface } from './strip/tab-bar-surface'
import { useTabBarItemActions } from './model/use-tab-bar-item-actions'
import { useActiveClientHostedBrowserRowId } from '@/runtime/browser/client-hosting/client-hosted-browser-row-state'
import { useEditorGroupFileDropOwner } from '../editor/file-drop/use-editor-group-file-drop-owner'
import { useBotForWorkspace, useBotGroupForWorkspace } from '../bots/bot-workspace'
import { useTranslate } from '@/i18n/use-translate'
import { useTabDragActive } from '../tab-group/drag/tab-drag-context'
import { useTabStripCondense } from './strip/use-tab-strip-condense'
import type { TabStripEntry } from './strip/TabStripOverflowChip'
import { useTerminalTabAttentionIds } from './terminal-tabs/use-terminal-tab-attention-ids'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { ClientHostedBrowserRow } from '../../../../shared/browser/client-hosting/client-hosted-browser-rows'

const EMPTY_ROWS: readonly ClientHostedBrowserRow[] = []
const NO_TERMINAL_TABS: readonly TerminalTab[] = []
const NO_IDS: readonly string[] = []

function TabBarInner(props: TabBarProps): React.JSX.Element {
  const t = useTranslate()
  const {
    worktreeId,
    groupId,
    terminalOnly = false,
    onNewTerminalTab,
    onNewTerminalWithShell,
    onNewBrowserTab,
    onNewSimulatorTab,
    onNewFileTab,
    onNewNamedFileTab,
    onOpenFileTab,
    onPinFile
  } = props
  const runtime = useTabBarRuntimeModel({ worktreeId, groupId })
  const bot = useBotForWorkspace(worktreeId)
  const botGroup = useBotGroupForWorkspace(worktreeId)
  const baseCreateMenu = useTabBarCreateMenuController({
    worktreeId,
    resolvedGroupId: runtime.resolvedGroupId,
    showAgentLaunchItems: props.showAgentLaunchItems,
    terminalOnly,
    mobileEmulatorEnabled: runtime.mobileEmulatorEnabled,
    managedBrowserCreationEnabled: runtime.managedBrowserCreationEnabled,
    mobileEmulatorCreationEnabled: runtime.mobileEmulatorCreationEnabled,
    workspaceHasSimulatorTab: runtime.workspaceHasSimulatorTab,
    showWindowsShellMenu: runtime.showWindowsShellMenu,
    projectRuntimeShellMenuMode: runtime.projectRuntimeShellMenuMode,
    defaultWindowsShell: runtime.defaultWindowsShell,
    defaultWindowsPowerShellImplementation: runtime.defaultWindowsPowerShellImplementation,
    agentDetectionTarget: runtime.agentDetectionTarget,
    windowsTerminalCapabilities: runtime.windowsTerminalCapabilities,
    onNewTerminalTab,
    onNewTerminalWithShell,
    onNewBrowserTab,
    onNewSimulatorTab,
    onNewFileTab,
    onNewNamedFileTab,
    onOpenFileTab
  })
  const pluginCreateMenu = usePluginNewFileMenuOptions(
    baseCreateMenu.createMenuOptions,
    baseCreateMenu.handleSelectCreateMenuOption,
    runtime.resolvedGroupId
  )
  const createMenu = {
    ...baseCreateMenu,
    createMenuOptions: pluginCreateMenu.menuOptions,
    handleSelectCreateMenuOption: pluginCreateMenu.onSelectMenuOption
  }
  const itemProjection = useTabBarItemProjection({
    props,
    resolvedGroupId: runtime.resolvedGroupId,
    unifiedTabs: runtime.unifiedTabs,
    unifiedTabByVisibleId: runtime.unifiedTabByVisibleId,
    generatedTabTitlesEnabled: runtime.generatedTabTitlesEnabled,
    statusByRelativePath: runtime.statusByRelativePath
  })
  const togglePinned = (item: TabBarItem): void => {
    // pinTab/unpinTab mirror the change to the host for remote-server tabs.
    if (item.isPinned) {
      runtime.unpinTab(item.unifiedTabId)
      return
    }
    if (item.type === 'editor' && onPinFile) {
      onPinFile(item.data.id, item.unifiedTabId)
      return
    }
    runtime.pinTab(item.unifiedTabId)
  }
  const itemActions = useTabBarItemActions({
    props,
    togglePinned,
    toggleTabViewMode: runtime.toggleTabViewMode
  })
  // Read here, not just where the rows render: the real tabs have to know when a row took over.
  const activeClientHostedBrowserRowId = useActiveClientHostedBrowserRowId({
    worktreeId,
    groupId: runtime.resolvedGroupId,
    groupActiveTabId: props.groupActiveTabId ?? null
  })
  const clientHostedBrowserRows = props.clientHostedBrowserRows ?? EMPTY_ROWS
  const stripEntries = useMemo<TabStripEntry[]>(
    () => [
      ...itemProjection.orderedItems.map((item) => ({ id: item.id, kind: 'item' as const, item })),
      ...clientHostedBrowserRows.map((row) => ({
        id: row.browserPageId,
        kind: 'paired' as const,
        row
      }))
    ],
    [itemProjection.orderedItems, clientHostedBrowserRows]
  )
  const stripIds = useMemo(() => stripEntries.map((entry) => entry.id), [stripEntries])
  const slotIds = useMemo(
    () => [
      ...itemProjection.sortableIds,
      ...(clientHostedBrowserRows ?? []).map((row) => row.browserPageId)
    ],
    [clientHostedBrowserRows, itemProjection.sortableIds]
  )
  // Why memoized: the key spans every tab, and a windowed strip re-renders as it scrolls.
  const stripLayoutKey = useMemo(
    () =>
      [
        itemProjection.tabStripLayoutKey,
        ...(clientHostedBrowserRows ?? []).map((row) => row.browserPageId)
      ].join('|'),
    [clientHostedBrowserRows, itemProjection.tabStripLayoutKey]
  )
  const tabStripNavigation = useTabStripOverflowNavigation({
    activeVisibleTabId: itemProjection.activeVisibleTabId,
    activeDockSlotId: activeClientHostedBrowserRowId ?? itemProjection.activeVisibleTabId,
    layoutKey: stripLayoutKey,
    slotIds,
    worktreeId
  })
  const isTabDragActive = useTabDragActive()
  const condense = useTabStripCondense({
    ids: stripIds,
    activeId: activeClientHostedBrowserRowId ?? itemProjection.activeVisibleTabId,
    frozen: isTabDragActive,
    hasOverflow: tabStripNavigation.tabStripOverflowState.hasOverflow
  })
  // Only an overflowing strip has a chip whose dot and list need attention state.
  const attentionTerminalTabs = useMemo(
    () =>
      condense.hiddenIds.size === 0
        ? NO_TERMINAL_TABS
        : itemProjection.orderedItems.flatMap((item) =>
            item.type === 'terminal' ? [item.data] : []
          ),
    [condense.hiddenIds, itemProjection.orderedItems]
  )
  const attentionChatTabIds = useMemo(
    () =>
      condense.hiddenIds.size === 0
        ? NO_IDS
        : itemProjection.orderedItems.flatMap((item) =>
            item.type === 'agent-session' ? [item.id] : []
          ),
    [condense.hiddenIds, itemProjection.orderedItems]
  )
  const attentionIds = useTerminalTabAttentionIds(attentionTerminalTabs, attentionChatTabIds)
  const attachFileDropOwner = useEditorGroupFileDropOwner({ worktreeId, groupId })
  const { clearPendingNewTabMenuFocusOnUnmount } = createMenu
  const { setSurface } = condense
  const surfaceRef = useCallback(
    (node: HTMLDivElement | null) => {
      clearPendingNewTabMenuFocusOnUnmount(node)
      attachFileDropOwner(node)
      setSurface(node)
    },
    [attachFileDropOwner, clearPendingNewTabMenuFocusOnUnmount, setSurface]
  )
  const tabStripDragScroll = useTabStripDragScrollHandlers(tabStripNavigation.scrollTabStrip, {
    start: tabStripNavigation.tabStripOverflowState.canScrollStart,
    end: tabStripNavigation.tabStripOverflowState.canScrollEnd
  })

  return renderTabBarSurface(
    {
      props,
      runtime,
      createMenu,
      itemProjection,
      tabStripNavigation,
      tabStripDragScroll,
      activeClientHostedBrowserRowId,
      itemActions,
      surfaceRef,
      bot,
      botGroup,
      condense,
      stripEntries,
      attentionIds
    },
    t
  )
}

export default React.memo(TabBarInner)
