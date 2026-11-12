import type { PluginHostListEntry } from '../../../../../preload/api-types'
import { PluginManager } from './PluginManager'
import { PluginsOffState } from './PluginsOffState'
import type { InstalledRowHandlers } from './PluginManagerRows'
import type { PluginLogsState } from '../state/use-plugin-logs'
import type { PluginPageNavigation } from '../state/use-plugin-page-navigation'

type PluginSettingsOverviewProps = {
  featureEnabled: boolean
  settingsError: string | null
  loading: boolean
  error: string | null
  plugins: PluginHostListEntry[]
  busyPluginKeys: ReadonlySet<string>
  /** Records a review decision made on the plugin's page. */
  onConsent: (
    pluginKey: string,
    reviewedFingerprint: string,
    decision: 'approve' | 'keep-disabled'
  ) => Promise<void>
  handlers: Omit<InstalledRowHandlers, 'onOpen' | 'onViewLogs' | 'onCheckUpdate'>
  onRefresh: () => Promise<void>
  onMarketplaceInstalled: (pluginKeys: string | readonly string[]) => Promise<void>
  logsByPlugin: Readonly<Record<string, PluginLogsState>>
  onShowLogs: (pluginKey: string) => void
  onOpenShortcuts: () => void
  sourcesOpen: boolean
  setSourcesOpen: (open: boolean) => void
  page: PluginPageNavigation
}

export function PluginSettingsOverview({
  featureEnabled,
  settingsError,
  loading,
  error,
  plugins,
  busyPluginKeys,
  onConsent,
  handlers,
  onRefresh,
  onMarketplaceInstalled,
  logsByPlugin,
  onShowLogs,
  onOpenShortcuts,
  sourcesOpen,
  setSourcesOpen,
  page
}: PluginSettingsOverviewProps): React.JSX.Element {
  return (
    <>
      {featureEnabled ? null : <PluginsOffState />}
      {settingsError ? <p className="text-xs text-destructive">{settingsError}</p> : null}
      {featureEnabled ? (
        <PluginManager
          plugins={plugins}
          pluginsLoading={loading}
          pluginsError={error}
          busyPluginKeys={busyPluginKeys}
          onConsent={onConsent}
          handlers={handlers}
          onRefreshInstalled={onRefresh}
          onInstalled={onMarketplaceInstalled}
          logsByPlugin={logsByPlugin}
          onShowLogs={onShowLogs}
          onOpenShortcuts={onOpenShortcuts}
          page={page}
          sourcesOpen={sourcesOpen}
          setSourcesOpen={setSourcesOpen}
        />
      ) : null}
    </>
  )
}
