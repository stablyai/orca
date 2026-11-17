import React, { useCallback, useMemo, useState } from 'react'
import { useTabStripOverflowNavigation } from './strip/tab-strip-overflow-navigation'
import { useTabStripDragScrollHandlers } from './strip/tab-strip-drag-scroll'
import {
  buildTabStripSegments,
  useFocusedTabStripSlotId,
  useTabStripRange
} from './strip/tab-strip-window'
import { useActiveDragVisibleTabId } from '../tab-group/drag/tab-drag-context'
import { sameStringArray } from '@/runtime/web-session-tabs-sync/snapshots/state-equality-core'
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
import { useTranslate } from '@/i18n/use-translate'

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
  const clientHostedBrowserRows = props.clientHostedBrowserRows
  const slotIds = useMemo(
    () => [
      ...itemProjection.sortableIds,
      ...(clientHostedBrowserRows ?? []).map((row) => row.browserPageId)
    ],
    [clientHostedBrowserRows, itemProjection.sortableIds]
  )
  const tabStripNavigation = useTabStripOverflowNavigation({
    activeVisibleTabId: itemProjection.activeVisibleTabId,
    activeDockSlotId: activeClientHostedBrowserRowId ?? itemProjection.activeVisibleTabId,
    layoutKey: [
      itemProjection.tabStripLayoutKey,
      ...(props.clientHostedBrowserRows ?? []).map((row) => row.browserPageId)
    ].join('|'),
    slotIds,
    worktreeId
  })
  const attachFileDropOwner = useEditorGroupFileDropOwner({ worktreeId, groupId })
  const { clearPendingNewTabMenuFocusOnUnmount } = createMenu
  const surfaceRef = useCallback(
    (node: HTMLDivElement | null) => {
      clearPendingNewTabMenuFocusOnUnmount(node)
      attachFileDropOwner(node)
    },
    [attachFileDropOwner, clearPendingNewTabMenuFocusOnUnmount]
  )
  const tabStripRange = useTabStripRange(
    tabStripNavigation.tabStripRef,
    itemProjection.orderedItems.length,
    tabStripNavigation.subscribeToStripResize
  )
  const focusedSlotId = useFocusedTabStripSlotId(
    tabStripNavigation.tabStripRef,
    tabStripRange !== null
  )
  const activeDragVisibleTabId = useActiveDragVisibleTabId()
  const { orderedItems, sortableIds, activeVisibleTabId } = itemProjection
  const tabStripWindow = useMemo(() => {
    if (tabStripRange === null) {
      return { segments: buildTabStripSegments(orderedItems.length, null, []), sortableIds }
    }
    // Keep the active, dragged and focused tabs mounted wherever they sit in the order.
    const keptIds = new Set([activeVisibleTabId, activeDragVisibleTabId, focusedSlotId])
    const keptIndices: number[] = []
    orderedItems.forEach((item, index) => {
      if (keptIds.has(item.id)) {
        keptIndices.push(index)
      }
    })
    const segments = buildTabStripSegments(orderedItems.length, tabStripRange, keptIndices)
    const mountedIds = segments.flatMap((segment) =>
      segment.kind === 'tabs' ? sortableIds.slice(segment.start, segment.end) : []
    )
    return { segments, sortableIds: mountedIds }
  }, [
    activeDragVisibleTabId,
    activeVisibleTabId,
    focusedSlotId,
    orderedItems,
    sortableIds,
    tabStripRange
  ])
  // Why: dnd-kit re-renders every mounted tab when this array's identity changes, and tab writes rebuild it.
  const [mountedSortableIds, setMountedSortableIds] = useState(tabStripWindow.sortableIds)
  if (!sameStringArray(mountedSortableIds, tabStripWindow.sortableIds)) {
    setMountedSortableIds(tabStripWindow.sortableIds)
  }
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
      tabStripWindow: { segments: tabStripWindow.segments, sortableIds: mountedSortableIds }
    },
    t
  )
}

export default React.memo(TabBarInner)
