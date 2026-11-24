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
import { useTabStripScrollMemory } from './strip/tab-strip-scroll-memory'
import { useTabDragActive } from '../tab-group/drag/tab-drag-context'
import { useTabStripCondense } from './strip/use-tab-strip-condense'
import type { TabStripEntry } from './strip/TabStripOverflowChip'
import { useTerminalTabAttentionIds } from './terminal-tabs/use-terminal-tab-attention-ids'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { ClientHostedBrowserRow } from '../../../../shared/browser/client-hosting/client-hosted-browser-rows'
import { buildTabDropIndicators } from './model/tab-bar-item-model'
import {
  findPinnedHomeTabId,
  stripSortableIdsWithoutPinnedHome,
  withPinnedHomeFirst
} from './model/pinned-home-tab'
import { resolveRenderedTabStrip } from './strip/rendered-tab-strip'

const EMPTY_ROWS: readonly ClientHostedBrowserRow[] = []
const NO_TERMINAL_TABS: readonly TerminalTab[] = []
const NO_IDS: readonly string[] = []
const itemIdOf = (item: TabBarItem): string => item.id
const idOf = (id: string): string => id

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
  const projectedItems = useTabBarItemProjection({
    props,
    resolvedGroupId: runtime.resolvedGroupId,
    unifiedTabs: runtime.unifiedTabs,
    unifiedTabByVisibleId: runtime.unifiedTabByVisibleId,
    generatedTabTitlesEnabled: runtime.generatedTabTitlesEnabled,
    statusByRelativePath: runtime.statusByRelativePath
  })
  const firstChat = projectedItems.orderedItems.find((item) => item.type === 'agent-session')
  const homeBot = useBotForWorkspace(
    worktreeId,
    firstChat?.type === 'agent-session' ? firstChat.data.executionHostId : undefined
  )
  const pinnedHomeId = findPinnedHomeTabId(projectedItems.orderedItems, homeBot)
  // Why memoized: dnd-kit re-renders every tab in a context whose items array changes identity.
  const orderedItems = useMemo(
    () => withPinnedHomeFirst(projectedItems.orderedItems, pinnedHomeId, itemIdOf),
    [projectedItems.orderedItems, pinnedHomeId]
  )
  const sortableIds = useMemo(
    () => withPinnedHomeFirst(projectedItems.sortableIds, pinnedHomeId, idOf),
    [projectedItems.sortableIds, pinnedHomeId]
  )
  const reorderedDropIndicators = useMemo(
    () =>
      orderedItems === projectedItems.orderedItems
        ? null
        : buildTabDropIndicators(orderedItems, projectedItems.hoveredInsertion),
    [orderedItems, projectedItems.orderedItems, projectedItems.hoveredInsertion]
  )
  const itemProjection = {
    ...projectedItems,
    orderedItems,
    sortableIds,
    dropIndicatorByVisibleId: reorderedDropIndicators ?? projectedItems.dropIndicatorByVisibleId
  }
  const pinnedSortableIds = useMemo(() => (pinnedHomeId ? [pinnedHomeId] : []), [pinnedHomeId])
  const stripSortableIds = useMemo(
    () => stripSortableIdsWithoutPinnedHome(sortableIds, pinnedHomeId),
    [sortableIds, pinnedHomeId]
  )
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
  // Every tab for the +N list, Home included, so its shortcut digits match the strip order.
  const stripEntries = useMemo<TabStripEntry[]>(
    () => [
      ...orderedItems.map((item) => ({ id: item.id, kind: 'item' as const, item })),
      ...clientHostedBrowserRows.map((row) => ({
        id: row.browserPageId,
        kind: 'paired' as const,
        row
      }))
    ],
    [orderedItems, clientHostedBrowserRows]
  )
  // The condense plan only lays out the strip: the pinned Home is never iconified or hidden behind +N.
  const stripIds = useMemo(
    () => stripEntries.flatMap((entry) => (entry.id === pinnedHomeId ? [] : [entry.id])),
    [stripEntries, pinnedHomeId]
  )
  const slotIds = useMemo(
    () => [...stripSortableIds, ...(clientHostedBrowserRows ?? []).map((row) => row.browserPageId)],
    [clientHostedBrowserRows, stripSortableIds]
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
  useTabStripScrollMemory(
    groupId,
    worktreeId,
    tabStripNavigation.tabStripRef,
    itemProjection.activeVisibleTabId
  )
  const isTabDragActive = useTabDragActive()
  const activeStripId = activeClientHostedBrowserRowId ?? itemProjection.activeVisibleTabId
  const condense = useTabStripCondense({
    ids: stripIds,
    activeId: activeStripId === pinnedHomeId ? null : activeStripId,
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
      strip: resolveRenderedTabStrip({
        itemProjection,
        pinnedSortableIds,
        stripSortableIds,
        hiddenIds: condense.hiddenIds,
        allClientHostedBrowserRows: clientHostedBrowserRows,
        activeId: activeStripId
      }),
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
