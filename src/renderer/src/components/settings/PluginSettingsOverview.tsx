import { Blocks, Loader2, SearchX } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { PluginCatalogEmptyState } from '../plugin-catalog/PluginCatalogEmptyState'
import { PluginDevelopmentSection } from './PluginDevelopmentSection'
import { PluginMarketplaceBrowser } from './PluginMarketplaceBrowser'
import { PluginSettingsRow, type PluginLogsState } from './PluginSettingsRow'
import { SettingsRow, SettingsSwitch } from './SettingsFormControls'

type PluginSettingsOverviewProps = {
  featureEnabled: boolean
  featureBusy: boolean
  settingsError: string | null
  loading: boolean
  error: string | null
  plugins: PluginHostListEntry[]
  busyPluginKeys: ReadonlySet<string>
  openLogs: ReadonlySet<string>
  logsByPlugin: Readonly<Record<string, PluginLogsState>>
  devPaths: readonly string[]
  devPathsBusy: boolean
  onToggleFeature: () => void
  onRefresh: () => Promise<void>
  onReview: (pluginKey: string) => void
  onToggleEnabled: (plugin: PluginHostListEntry) => void
  onToggleLogs: (pluginKey: string) => void
  onMarketplaceInstalled: (pluginKey: string) => Promise<void>
  onRollbackRequest: (pluginKey: string) => void
  onRemoveRequest: (pluginKey: string) => void
  onUpdateDevPaths: (paths: string[]) => Promise<void>
}

function matchesInstalledPlugin(plugin: PluginHostListEntry, search: string): boolean {
  const query = search.trim().toLocaleLowerCase()
  return (
    !query ||
    [plugin.name, plugin.pluginKey, plugin.publisher, plugin.description ?? ''].some((value) =>
      value.toLocaleLowerCase().includes(query)
    )
  )
}

export function PluginSettingsOverview({
  featureEnabled,
  featureBusy,
  settingsError,
  loading,
  error,
  plugins,
  busyPluginKeys,
  openLogs,
  logsByPlugin,
  devPaths,
  devPathsBusy,
  onToggleFeature,
  onRefresh,
  onReview,
  onToggleEnabled,
  onToggleLogs,
  onMarketplaceInstalled,
  onRollbackRequest,
  onRemoveRequest,
  onUpdateDevPaths
}: PluginSettingsOverviewProps): React.JSX.Element {
  return (
    <>
      <SettingsRow
        label={translate(
          'auto.components.settings.PluginsSettingsSection.systemLabel',
          'Plugin system'
        )}
        labelId="plugin-system-label"
        description={translate(
          'auto.components.settings.PluginsSettingsSection.systemDescription',
          'Discovers installed plugins and lets you enable them individually. Nothing runs until you review and enable it. Workers always run on this computer; SSH workspace actions route through Orca.'
        )}
        alignTop
        control={
          <SettingsSwitch
            checked={featureEnabled}
            disabled={featureBusy}
            ariaLabelledBy="plugin-system-label"
            onChange={onToggleFeature}
          />
        }
      />
      {settingsError ? <p className="text-xs text-destructive">{settingsError}</p> : null}
      <div className="my-4 border-t border-border/60" />
      {!featureEnabled ? (
        <div className="rounded-lg border border-dashed border-border px-5 py-6 text-center text-[13px] leading-6 text-muted-foreground">
          {translate(
            'auto.components.settings.PluginsSettingsSection.featureOff',
            'Turn on the plugin system to see and manage installed plugins. Anything already installed stays on disk and stays disabled while the system is off.'
          )}
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 px-4 py-5 text-[13px] text-muted-foreground">
          <Loader2 className="animate-spin" />
          {translate('auto.components.settings.PluginsSettingsSection.loading', 'Loading plugins…')}
        </div>
      ) : (
        <>
          <PluginMarketplaceBrowser
            installedPlugins={plugins}
            onInstalled={onMarketplaceInstalled}
            onRefreshInstalled={onRefresh}
            renderInstalledContent={(search) => {
              const filteredPlugins = plugins.filter((plugin) =>
                matchesInstalledPlugin(plugin, search)
              )
              if (error) {
                return (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    {error}
                  </div>
                )
              }
              if (filteredPlugins.length === 0) {
                return search ? (
                  <PluginCatalogEmptyState
                    icon={SearchX}
                    title={translate(
                      'auto.components.settings.PluginsSettingsSection.noInstalledResultsTitle',
                      'No matching plugins'
                    )}
                    description={translate(
                      'auto.components.settings.PluginsSettingsSection.noInstalledResults',
                      'No installed plugins match this search.'
                    )}
                  />
                ) : (
                  <PluginCatalogEmptyState
                    icon={Blocks}
                    title={translate(
                      'auto.components.settings.PluginsSettingsSection.emptyTitle',
                      'No plugins installed yet'
                    )}
                    description={translate(
                      'auto.components.settings.PluginsSettingsSection.empty',
                      'Browse the All tab to install plugins from a marketplace.'
                    )}
                  />
                )
              }
              return (
                <div className="grid gap-3 lg:grid-cols-2">
                  {filteredPlugins.map((plugin) => (
                    <PluginSettingsRow
                      key={plugin.pluginKey}
                      plugin={plugin}
                      busy={busyPluginKeys.has(plugin.pluginKey)}
                      logsOpen={openLogs.has(plugin.pluginKey)}
                      logsState={logsByPlugin[plugin.pluginKey]}
                      onReview={onReview}
                      onToggleEnabled={onToggleEnabled}
                      onToggleLogs={onToggleLogs}
                      onRollbackRequest={onRollbackRequest}
                      onRemoveRequest={onRemoveRequest}
                    />
                  ))}
                </div>
              )
            }}
          />
          <div className="my-4 border-t border-border/60" />
          <PluginDevelopmentSection
            paths={devPaths}
            busy={devPathsBusy}
            onChange={onUpdateDevPaths}
          />
        </>
      )}
    </>
  )
}
