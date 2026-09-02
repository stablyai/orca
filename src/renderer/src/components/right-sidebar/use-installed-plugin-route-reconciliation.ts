import { useEffect } from 'react'
import { isPluginPanelTabKey } from '../../../../shared/plugins/plugin-manifest'
import type { PluginPanelsFetchStatus } from '@/store/plugin-panels'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'

/** Persists removal only after the authoritative installed list is ready. */
export function useInstalledPluginRouteReconciliation(input: {
  pluginSystemEnabled: boolean
  fetchStatus: PluginPanelsFetchStatus
  storedTab: ActiveRightSidebarTab
  normalizedTab: ActiveRightSidebarTab
  setStoredTab: (tab: ActiveRightSidebarTab) => void
}): void {
  const { pluginSystemEnabled, fetchStatus, storedTab, normalizedTab, setStoredTab } = input
  useEffect(() => {
    if (
      pluginSystemEnabled &&
      fetchStatus === 'ready' &&
      isPluginPanelTabKey(storedTab) &&
      normalizedTab !== storedTab
    ) {
      setStoredTab(normalizedTab)
    }
  }, [fetchStatus, normalizedTab, pluginSystemEnabled, setStoredTab, storedTab])
}
