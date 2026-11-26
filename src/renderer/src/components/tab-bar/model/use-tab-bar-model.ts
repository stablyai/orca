import { useCallback, useMemo } from 'react'
import type { TabBarProps } from '../tab-bar-props'
import type { TabBarItem } from './tab-bar-item-model'
import { buildTabDropIndicators } from './tab-bar-item-model'
import { useTabBarRuntimeModel, type TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import { useTabBarCreateMenuController } from '../create-menu/use-tab-bar-create-menu-controller'
import { usePluginNewFileMenuOptions } from '../create-menu/use-plugin-new-file-menu-options'
import type { TabBarCreateMenuController } from '../create-menu/tab-bar-create-menu-contract'
import { useTabBarItemProjection, type TabBarItemProjection } from './use-tab-bar-item-projection'
import { useTabBarItemActions, type TabBarItemActions } from './use-tab-bar-item-actions'
import { useActiveClientHostedBrowserRowId } from '@/runtime/browser/client-hosting/client-hosted-browser-row-state'
import { useEditorGroupFileDropOwner } from '../../editor/file-drop/use-editor-group-file-drop-owner'
import { findBotByWorkspace, useBotGroupForWorkspace } from '../../bots/bot-workspace'
import { homeBotLookupFor } from '../../bots/bot-home-tab-order'
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import type { ClientHostedBrowserRow } from '../../../../../shared/browser/client-hosting/client-hosted-browser-rows'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotGroup } from '../../../../../shared/bots/bot-group'
import {
  findPinnedHomeTabId,
  stripSortableIdsWithoutPinnedHome,
  withPinnedHomeFirst
} from './pinned-home-tab'

const EMPTY_ROWS: readonly ClientHostedBrowserRow[] = []
const itemIdOf = (item: TabBarItem): string => item.id
const idOf = (id: string): string => id

export type TabBarModel = {
  runtime: TabBarRuntimeModel
  createMenu: TabBarCreateMenuController
  itemProjection: TabBarItemProjection
  /** A bot's pinned Home, rendered in its own sortable context ahead of the strip. */
  pinnedSortableIds: string[]
  stripSortableIds: string[]
  activeClientHostedBrowserRowId: string | null
  clientHostedBrowserRows: readonly ClientHostedBrowserRow[]
  itemActions: TabBarItemActions
  surfaceRef: (node: HTMLDivElement | null) => void
  bot: Bot | null
  botGroup: BotGroup | null
}

/** Everything a tab bar draws, shared by the top strip and the left vertical list so neither forks the model. */
export function useTabBarModel(props: TabBarProps): TabBarModel {
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
  const botsEnabled = useBotsEnabled()
  const bots = useBots(botsEnabled && parseWorkspaceKey(worktreeId)?.type === 'folder')
  // One catalog subscription: the page's bot (as useBotForWorkspace finds it) and each chat's Home lookup.
  const bot = findBotByWorkspace(bots, worktreeId)
  // Each chat asks for the bot on its own host, as its row does, so a mixed-host group never borrows another's Home.
  // Null on a strip no bot calls home (any Git worktree, bots off), which then skips the walk over its tabs.
  const homeBotFor = useMemo(() => homeBotLookupFor(bots, worktreeId), [bots, worktreeId])
  const pinnedHomeId = useMemo(
    () => findPinnedHomeTabId(projectedItems.orderedItems, homeBotFor),
    [projectedItems.orderedItems, homeBotFor]
  )
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
  const attachFileDropOwner = useEditorGroupFileDropOwner({ worktreeId, groupId })
  const { clearPendingNewTabMenuFocusOnUnmount } = createMenu
  const surfaceRef = useCallback(
    (node: HTMLDivElement | null) => {
      clearPendingNewTabMenuFocusOnUnmount(node)
      attachFileDropOwner(node)
    },
    [attachFileDropOwner, clearPendingNewTabMenuFocusOnUnmount]
  )
  return {
    runtime,
    createMenu,
    itemProjection,
    pinnedSortableIds,
    stripSortableIds,
    activeClientHostedBrowserRowId,
    clientHostedBrowserRows: props.clientHostedBrowserRows ?? EMPTY_ROWS,
    itemActions,
    surfaceRef,
    bot,
    botGroup
  }
}
