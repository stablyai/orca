import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import type { ActiveRightSidebarTab } from '../../../../../shared/ui-chrome/ui-chrome-types'
import type { PluginPanelsFetchStatus } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { normalizeRightSidebarRoute } from '@/store/slices/right-sidebar/right-sidebar-route'
import { resolveRightSidebarEffectiveTab } from './right-sidebar-effective-tab'
import { useInstalledPluginRouteReconciliation } from '../plugin-panels/use-installed-plugin-route-reconciliation'
import type { ActivityBarItem } from './activity-bar-buttons'
import { openBotConnectorPage } from '@/components/bots/bot-connector-page'

// The last route request the panel saw, kept across unmounts: Settings unmounts it, and a request
// made there (open a bot's Connectors) is still new when the panel mounts again.
let seenRouteRequestId: number | null = null

export type RightSidebarTabRouting = {
  effectiveTab: ActiveRightSidebarTab
  selectActivityTab: (tab: ActiveRightSidebarTab) => void
}

export function useRightSidebarTabRouting({
  visibleItems,
  activeFolderWorkspaceKey,
  pluginSystemEnabled,
  pluginFetchStatus,
  installedPluginTabKeys,
  isBotPage
}: {
  visibleItems: ActivityBarItem[]
  isBotPage: boolean
  activeFolderWorkspaceKey: string | null
  pluginSystemEnabled: boolean
  pluginFetchStatus: PluginPanelsFetchStatus
  installedPluginTabKeys: Set<string>
}): RightSidebarTabRouting {
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const rightSidebarRouteRequestId = useAppStore((s) => s.rightSidebarRouteRequestId)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const showRightSidebarFiles = useAppStore((s) => s.showRightSidebarFiles)
  const setRightSidebarEffectiveTab = useAppStore((s) => s.setRightSidebarEffectiveTab)

  const rememberedFolderTabByWorkspaceKeyRef = useRef<Record<string, ActiveRightSidebarTab>>({})
  const lastRightSidebarRouteRequestIdRef = useRef(seenRouteRequestId ?? rightSidebarRouteRequestId)

  // Preserve stored routes when hidden; folder effective-tab memory keeps parent overviews, while authoritative installed-panel keys discard uninstalled plugin routes.
  const normalizedActiveTab = normalizeRightSidebarRoute(rightSidebarTab, undefined, {
    installedPluginTabKeys:
      pluginSystemEnabled && pluginFetchStatus === 'ready' ? installedPluginTabKeys : undefined
  }).rightSidebarTab
  const rememberedFolderTab = activeFolderWorkspaceKey
    ? rememberedFolderTabByWorkspaceKeyRef.current[activeFolderWorkspaceKey]
    : null
  const requestedFolderTab =
    activeFolderWorkspaceKey &&
    rightSidebarRouteRequestId !== lastRightSidebarRouteRequestIdRef.current
      ? normalizedActiveTab
      : null
  const effectiveTab = resolveRightSidebarEffectiveTab({
    normalizedActiveTab,
    visibleItems,
    activeFolderWorkspaceKey,
    rememberedFolderTab: requestedFolderTab ?? rememberedFolderTab,
    leadWithFirstTab: isBotPage
  })

  useInstalledPluginRouteReconciliation({
    pluginSystemEnabled,
    fetchStatus: pluginFetchStatus,
    storedTab: rightSidebarTab,
    normalizedTab: normalizedActiveTab,
    setStoredTab: setRightSidebarTab
  })

  // Watch the displayed panel, including fallbacks for hidden stored tabs.
  useEffect(() => {
    setRightSidebarEffectiveTab(effectiveTab)
  }, [effectiveTab, setRightSidebarEffectiveTab])
  useEffect(() => () => setRightSidebarEffectiveTab(null), [setRightSidebarEffectiveTab])

  useEffect(() => {
    lastRightSidebarRouteRequestIdRef.current = rightSidebarRouteRequestId
    seenRouteRequestId = rightSidebarRouteRequestId
  }, [rightSidebarRouteRequestId])

  useEffect(() => {
    if (!activeFolderWorkspaceKey || !visibleItems.some((item) => item.id === effectiveTab)) {
      return
    }
    rememberedFolderTabByWorkspaceKeyRef.current[activeFolderWorkspaceKey] = effectiveTab
  }, [activeFolderWorkspaceKey, effectiveTab, visibleItems])
  const selectActivityTab = (tab: ActiveRightSidebarTab): void => {
    if (activeFolderWorkspaceKey) {
      rememberedFolderTabByWorkspaceKeyRef.current[activeFolderWorkspaceKey] = tab
    }
    if (tab === 'explorer') {
      showRightSidebarFiles()
      return
    }
    // Connectors again, while it shows a connector's page: back to the list.
    if (tab === 'bot-connectors' && effectiveTab === 'bot-connectors') {
      openBotConnectorPage(null)
    }
    setRightSidebarTab(tab)
  }

  return { effectiveTab, selectActivityTab }
}
