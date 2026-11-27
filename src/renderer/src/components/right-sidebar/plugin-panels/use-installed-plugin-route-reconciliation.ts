import { useEffect } from 'react'
import { isPluginPanelTabKey } from '../../../../../shared/plugins/frames/plugin-tab-key'
import type { PluginPanelsFetchStatus } from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { ActiveRightSidebarTab } from '../../../../../shared/ui-chrome/ui-chrome-types'

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
