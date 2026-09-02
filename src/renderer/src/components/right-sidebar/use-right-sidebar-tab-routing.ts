import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'
import type { PluginPanelsFetchStatus } from '@/store/plugin-panels'
import { normalizeRightSidebarRoute } from '@/store/right-sidebar-route'
import { resolveRightSidebarEffectiveTab } from './right-sidebar-effective-tab'
import { useInstalledPluginRouteReconciliation } from './use-installed-plugin-route-reconciliation'
import type { ActivityBarItem } from './activity-bar-buttons'

export type RightSidebarTabRouting = {
  effectiveTab: ActiveRightSidebarTab
  selectActivityTab: (tab: ActiveRightSidebarTab) => void
}

export function useRightSidebarTabRouting({
  visibleItems,
  activeFolderWorkspaceKey,
  pluginSystemEnabled,
  pluginFetchStatus,
  installedPluginTabKeys
}: {
  visibleItems: ActivityBarItem[]
  activeFolderWorkspaceKey: string | null
  pluginSystemEnabled: boolean
  pluginFetchStatus: PluginPanelsFetchStatus
  installedPluginTabKeys: Set<string>
}): RightSidebarTabRouting {
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const rightSidebarRouteRequestId = useAppStore((s) => s.rightSidebarRouteRequestId)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const showRightSidebarFiles = useAppStore((s) => s.showRightSidebarFiles)

  const rememberedFolderTabByWorkspaceKeyRef = useRef<Record<string, ActiveRightSidebarTab>>({})
  const lastRightSidebarRouteRequestIdRef = useRef(rightSidebarRouteRequestId)

  // If the active tab is hidden (e.g. switched from a folder workspace to a git
  // worktree), render a visible fallback without overwriting the stored route.
  // Folder workspaces keep a session-local effective-tab memory so a PR Checks
  // row can open a child Checks tab without erasing the parent's overview tab.
  // Why: pass the installed-panel set so a persisted tab for an UNINSTALLED
  // plugin drops to Explorer instead of surviving as a dead route.
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
    rememberedFolderTab: requestedFolderTab ?? rememberedFolderTab
  })

  useInstalledPluginRouteReconciliation({
    pluginSystemEnabled,
    fetchStatus: pluginFetchStatus,
    storedTab: rightSidebarTab,
    normalizedTab: normalizedActiveTab,
    setStoredTab: setRightSidebarTab
  })

  useEffect(() => {
    lastRightSidebarRouteRequestIdRef.current = rightSidebarRouteRequestId
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
    setRightSidebarTab(tab)
  }

  return { effectiveTab, selectActivityTab }
}
