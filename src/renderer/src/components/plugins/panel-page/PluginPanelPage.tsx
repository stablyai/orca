import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { Suspense, useEffect } from 'react'
import { useAppStore } from '@/store/index'
import {
  usePluginPanels,
  usePluginPanelsStore
} from '@/store/plugins/catalog/plugin-contribution-catalog'

const PluginPanel = lazy(() => import('../../right-sidebar/plugin-panels/PluginPanel'))

/** A `placement: "page"` panel drawn across the main area, opened from the left sidebar. */
export default function PluginPanelPage(): React.JSX.Element | null {
  const tabKey = useAppStore((s) => s.activePluginPageTabKey)
  const pluginSystemEnabled = useAppStore((s) => s.settings?.pluginSystemEnabled === true)
  const closePluginPage = useAppStore((s) => s.closePluginPage)
  const fetchStatus = usePluginPanelsStore((s) => s.fetchStatus)
  const panels = usePluginPanels()
  const available = panels.some((panel) => panel.tabKey === tabKey && panel.placement === 'page')

  // Why wait for ready: a refresh in flight must not close a page whose plugin is merely reloading.
  useEffect(() => {
    if (!tabKey || !pluginSystemEnabled || (fetchStatus === 'ready' && !available)) {
      closePluginPage()
    }
  }, [available, closePluginPage, fetchStatus, pluginSystemEnabled, tabKey])

  if (!tabKey) {
    return null
  }
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      // `orca plugin shot` captures exactly this rect.
      data-plugin-panel-surface={tabKey}
    >
      <Suspense fallback={null}>
        {/* Remount per panel so an old guest cannot post through the next panel's bridge. */}
        <PluginPanel key={tabKey} tabKey={tabKey} />
      </Suspense>
    </div>
  )
}
