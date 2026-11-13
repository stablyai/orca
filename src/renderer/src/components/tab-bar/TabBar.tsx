import React, { useCallback, useMemo } from 'react'
import { useTabStripOverflowNavigation } from './tab-strip-overflow-navigation'
import { useTabStripDragScrollHandlers } from './tab-strip-drag-scroll'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarItem } from './tab-bar-item-model'
import { useTabBarRuntimeModel } from './use-tab-bar-runtime-model'
import { useTabBarCreateMenuController } from './use-tab-bar-create-menu-controller'
import { usePluginNewFileMenuOptions } from './use-plugin-new-file-menu-options'
import { useTabBarItemProjection } from './use-tab-bar-item-projection'
import { renderTabBarSurface } from './tab-bar-surface'
import { useTabBarItemActions } from './use-tab-bar-item-actions'
import { useActiveClientHostedBrowserRowId } from '@/runtime/browser/client-hosting/client-hosted-browser-row-state'
import { useEditorGroupFileDropOwner } from '../editor/use-editor-group-file-drop-owner'
import { useTranslate } from '@/i18n/use-translate'
import { useTabDragActive } from '../tab-group/tab-drag-context'
import { useTabStripCondense } from './use-tab-strip-condense'
import type { TabStripEntry } from './TabStripOverflowChip'
import { useTerminalTabAttentionIds } from './use-terminal-tab-attention-ids'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'

const EMPTY_ROWS: readonly ClientHostedBrowserRow[] = []
const NO_TERMINAL_TABS: readonly TerminalTab[] = []

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
  const tabStripNavigation = useTabStripOverflowNavigation({
    activeVisibleTabId: itemProjection.activeVisibleTabId,
    activeDockSlotId: activeClientHostedBrowserRowId ?? itemProjection.activeVisibleTabId,
    layoutKey: [
      itemProjection.tabStripLayoutKey,
      ...(props.clientHostedBrowserRows ?? []).map((row) => row.browserPageId)
    ].join('|'),
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
  const attentionIds = useTerminalTabAttentionIds(attentionTerminalTabs)
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
      condense,
      stripEntries,
      attentionIds
    },
    t
  )
}

export default React.memo(TabBarInner)
