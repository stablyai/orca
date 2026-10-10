import React, { useCallback } from 'react'
import { useTabStripOverflowNavigation } from './tab-strip-overflow-navigation'
import { useTabStripDragScrollHandlers } from './tab-strip-drag-scroll'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarItem } from './tab-bar-item-model'
import { useTabBarRuntimeModel } from './use-tab-bar-runtime-model'
import { useTabBarCreateMenuController } from './use-tab-bar-create-menu-controller'
import { useTabBarItemProjection } from './use-tab-bar-item-projection'
import { renderTabBarSurface } from './tab-bar-surface'
import { useTabBarItemActions } from './use-tab-bar-item-actions'
import { useActiveClientHostedBrowserRowId } from '@/lib/pane-manager/client-hosted-browser-row-state'
import { useEditorGroupFileDropOwner } from '../editor/use-editor-group-file-drop-owner'

function TabBarInner(props: TabBarProps): React.JSX.Element {
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
  const createMenu = useTabBarCreateMenuController({
    worktreeId,
    resolvedGroupId: runtime.resolvedGroupId,
    terminalOnly,
    mobileEmulatorEnabled: runtime.mobileEmulatorEnabled,
    managedBrowserCreationEnabled: runtime.managedBrowserCreationEnabled,
    mobileEmulatorCreationEnabled: runtime.mobileEmulatorCreationEnabled,
    workspaceHasSimulatorTab: runtime.workspaceHasSimulatorTab,
    showWindowsShellMenu: runtime.showWindowsShellMenu,
    projectRuntimeShellMenuMode: runtime.projectRuntimeShellMenuMode,
    defaultWindowsShell: runtime.defaultWindowsShell,
    defaultWindowsPowerShellImplementation: runtime.defaultWindowsPowerShellImplementation,
    windowsTerminalCapabilities: runtime.windowsTerminalCapabilities,
    agentLaunchOptions: runtime.agentLaunchOptions,
    onNewTerminalTab,
    onNewTerminalWithShell,
    onNewBrowserTab,
    onNewSimulatorTab,
    onNewFileTab,
    onOpenFileTab
  })
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
  const tabStripNavigation = useTabStripOverflowNavigation({
    activeVisibleTabId: itemProjection.activeVisibleTabId,
    activeDockSlotId: activeClientHostedBrowserRowId ?? itemProjection.activeVisibleTabId,
    layoutKey: [
      itemProjection.tabStripLayoutKey,
      ...(props.clientHostedBrowserRows ?? []).map((row) => row.browserPageId)
    ].join('|'),
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
  const tabStripDragScroll = useTabStripDragScrollHandlers(tabStripNavigation.scrollTabStrip, {
    start: tabStripNavigation.tabStripOverflowState.canScrollStart,
    end: tabStripNavigation.tabStripOverflowState.canScrollEnd
  })

  return renderTabBarSurface({
    props,
    runtime,
    createMenu,
    itemProjection,
    tabStripNavigation,
    tabStripDragScroll,
    activeClientHostedBrowserRowId,
    itemActions,
    surfaceRef
  })
}

export default React.memo(TabBarInner)
