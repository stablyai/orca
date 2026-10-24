import { Puzzle } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { PluginListGroup } from '../plugin-catalog/PluginListGroup'
import { PluginListRow } from '../plugin-catalog/PluginListRow'
import { pluginListEntryFromInstalled } from '../plugin-catalog/plugin-list-entries'
import { PluginDevelopmentSection } from './PluginDevelopmentSection'
import { PluginFileTypeSuggestionSetting } from './PluginFileTypeSuggestionSetting'
import { PluginManager } from './PluginManager'
import type { InstalledRowHandlers } from './PluginManagerRows'
import { PluginChips } from '../plugin-catalog/PluginChips'
import { SettingsRow, SettingsSwitch } from './SettingsFormControls'
import type { PluginLogsState } from './use-plugin-logs'
import type { PluginPageNavigation } from './use-plugin-page-navigation'

type PluginSettingsOverviewProps = {
  featureEnabled: boolean
  featureBusy: boolean
  settingsError: string | null
  loading: boolean
  error: string | null
  plugins: PluginHostListEntry[]
  busyPluginKeys: ReadonlySet<string>
  devPaths: readonly string[]
  devPathsBusy: boolean
  handlers: Omit<InstalledRowHandlers, 'onCheckUpdate'>
  onToggleFeature: () => void
  onRefresh: () => Promise<void>
  onMarketplaceInstalled: (pluginKeys: string | readonly string[]) => Promise<void>
  onUpdateDevPaths: (paths: string[]) => Promise<void>
  logsByPlugin: Readonly<Record<string, PluginLogsState>>
  onShowLogs: (pluginKey: string) => void
  onOpenShortcuts: () => void
  sourcesOpen: boolean
  setSourcesOpen: (open: boolean) => void
  page: PluginPageNavigation
}

/** The Settings body card; the section body is transparent so each block draws its own. */
function SettingsCard({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn('rounded-xl border border-border/50 bg-card/50 shadow-xs', className)}>
      {children}
    </div>
  )
}

/** With plugins off: what off means, the way back on, and who is installed (inert). */
function PluginsOffState({
  plugins,
  featureBusy,
  onTurnOn
}: {
  plugins: readonly PluginHostListEntry[]
  featureBusy: boolean
  onTurnOn: () => void
}): React.JSX.Element {
  return (
    <>
      <SettingsCard className="flex items-center gap-4 px-5 py-4">
        <Puzzle className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {translate(
              'auto.components.settings.PluginSettingsOverview.offTitle',
              'Plugins are off'
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.PluginSettingsOverview.offBody',
              'Nothing from your plugins runs. Turn them on to browse the catalog and use what you installed.'
            )}
          </p>
        </div>
        <Button size="sm" disabled={featureBusy} onClick={onTurnOn}>
          {translate('auto.components.settings.PluginSettingsOverview.turnOn', 'Turn on plugins')}
        </Button>
      </SettingsCard>
      <SettingsCard className="px-7 py-4">
        <PluginFileTypeSuggestionSetting />
      </SettingsCard>
      {plugins.length > 0 ? (
        <SettingsCard className="@container/plugin-list overflow-hidden">
          <PluginListGroup
            title={translate('auto.components.settings.PluginManager.installed', 'Installed')}
            aside={translate(
              'auto.components.settings.PluginSettingsOverview.pausedCount',
              '{{value0}} paused',
              { value0: plugins.length }
            )}
          >
            {plugins.map((plugin) => {
              const entry = pluginListEntryFromInstalled(plugin)
              return (
                <PluginListRow
                  key={plugin.pluginKey}
                  entry={entry}
                  description={entry.description ?? ''}
                  chips={<PluginChips entry={entry} />}
                  dimmed
                  inert
                />
              )
            })}
          </PluginListGroup>
        </SettingsCard>
      ) : null}
    </>
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
  devPaths,
  devPathsBusy,
  handlers,
  onToggleFeature,
  onRefresh,
  onMarketplaceInstalled,
  onUpdateDevPaths,
  logsByPlugin,
  onShowLogs,
  onOpenShortcuts,
  sourcesOpen,
  setSourcesOpen,
  page
}: PluginSettingsOverviewProps): React.JSX.Element {
  const pageOpen = page.openKey !== null
  return (
    <>
      {featureEnabled && pageOpen ? null : featureEnabled ? (
        <SettingsCard className="divide-y divide-border/60 px-7 py-1">
          <SettingsRow
            className="py-4"
            label={translate(
              'auto.components.settings.PluginsSettingsSection.systemLabel',
              'Plugin system'
            )}
            labelId="plugin-system-label"
            description={translate(
              'auto.components.settings.PluginSettingsOverview.systemDescription',
              'Turns every plugin off at once. Nothing runs until you review and enable it.'
            )}
            control={
              <SettingsSwitch
                checked={featureEnabled}
                disabled={featureBusy}
                ariaLabelledBy="plugin-system-label"
                onChange={onToggleFeature}
              />
            }
          />
          <div className="py-4">
            <PluginFileTypeSuggestionSetting />
          </div>
        </SettingsCard>
      ) : (
        <PluginsOffState plugins={plugins} featureBusy={featureBusy} onTurnOn={onToggleFeature} />
      )}
      {settingsError ? <p className="text-xs text-destructive">{settingsError}</p> : null}
      {featureEnabled ? (
        <PluginManager
          plugins={plugins}
          pluginsLoading={loading}
          pluginsError={error}
          busyPluginKeys={busyPluginKeys}
          handlers={handlers}
          onRefreshInstalled={onRefresh}
          onInstalled={onMarketplaceInstalled}
          logsByPlugin={logsByPlugin}
          onShowLogs={onShowLogs}
          onOpenShortcuts={onOpenShortcuts}
          page={page}
          sourcesOpen={sourcesOpen}
          setSourcesOpen={setSourcesOpen}
          footer={
            <SettingsCard className="px-7 py-4">
              <PluginDevelopmentSection
                paths={devPaths}
                busy={devPathsBusy}
                onChange={onUpdateDevPaths}
              />
            </SettingsCard>
          }
        />
      ) : null}
    </>
  )
}
