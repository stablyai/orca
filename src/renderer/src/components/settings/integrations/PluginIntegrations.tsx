import { ArrowLeft, ChevronDown, Plug } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { PluginSettingsChangeOrigin } from '../../../../../shared/plugins/workers/plugin-panel-bridge-protocol'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { resolvePluginIconGlyph } from '@/components/plugins/plugin-icon-glyphs'
import { PluginSettingsSection } from '@/components/plugins/page/PluginSettingsSection'
import PluginPanel from '@/components/right-sidebar/plugin-panels/PluginPanel'
import {
  collectPluginSettingsPanels,
  isLivePlugin,
  usePluginListDerived,
  usePluginPanelsStore
} from '@/store/plugins/catalog/plugin-contribution-catalog'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { openPluginsSettings } from '../navigation/open-plugins-settings'
import {
  openPluginIntegrationSettings,
  PLUGIN_INTEGRATION_SETTINGS_TARGET,
  usePluginIntegrationNavigation
} from './plugin-integration-navigation'

export function PluginIntegrationsGroup(): React.JSX.Element | null {
  const t = useTranslate()
  const panels = usePluginListDerived(collectPluginSettingsPanels)
  const plugins = usePluginPanelsStore((state) => state.plugins)
  if (panels.length === 0) {
    return null
  }
  return (
    <SettingsGroup
      title={t('pluginIntegrations.title', 'Plugin integrations')}
      description={t(
        'pluginIntegrations.description',
        'Manage connections provided by your installed plugins.'
      )}
    >
      {panels.map((panel) => {
        const plugin = plugins.find((entry) => entry.pluginKey === panel.pluginKey)
        if (!plugin) {
          return null
        }
        const enabled = isLivePlugin(plugin) && !plugin.needsReconsent
        const Icon = resolvePluginIconGlyph(panel.icon, Plug)
        return (
          <div
            key={panel.tabKey}
            data-settings-row=""
            className="flex min-h-11 items-center gap-3 py-3"
          >
            <Icon className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{panel.pluginName}</p>
              <p className="text-settings-detail text-muted-foreground">
                {enabled
                  ? panel.title
                  : t(
                      'pluginIntegrations.enableFirst',
                      'Enable this plugin in Plugins to configure its connection.'
                    )}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-label={
                enabled
                  ? t('pluginIntegrations.configureNamed', 'Configure {{name}}', {
                      name: panel.pluginName
                    })
                  : undefined
              }
              onClick={() =>
                enabled ? openPluginIntegrationSettings(panel.pluginKey) : openPluginsSettings()
              }
            >
              {enabled
                ? t('pluginIntegrations.configure', 'Configure')
                : t('pluginIntegrations.manage', 'Manage plugin')}
            </Button>
          </div>
        )
      })}
    </SettingsGroup>
  )
}

export function PluginIntegrationSettings({ pluginKey }: { pluginKey: string }): React.JSX.Element {
  const t = useTranslate()
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [draftRevisions, setDraftRevisions] = useState<Readonly<Record<string, number>>>({})
  const onSettingsChanged = useCallback((key: string, origin?: PluginSettingsChangeOrigin) => {
    setSettingsRevision((revision) => revision + 1)
    if (origin === 'plugin') {
      setDraftRevisions((revisions) => ({ ...revisions, [key]: (revisions[key] ?? 0) + 1 }))
    }
  }, [])
  const panels = usePluginListDerived(collectPluginSettingsPanels)
  const plugins = usePluginPanelsStore((state) => state.plugins)
  const panel = panels.find((entry) => entry.pluginKey === pluginKey)
  const plugin = plugins.find((entry) => entry.pluginKey === pluginKey)
  const enabled = plugin && isLivePlugin(plugin) && !plugin.needsReconsent
  return (
    <div id={PLUGIN_INTEGRATION_SETTINGS_TARGET} className="space-y-6 scroll-mt-8">
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => usePluginIntegrationNavigation.getState().show(null)}
        >
          <ArrowLeft />
          {t('pluginIntegrations.back', 'All integrations')}
        </Button>
        {panel && enabled ? (
          <Button variant="outline" size="sm" onClick={openPluginsSettings}>
            {t('pluginIntegrations.manage', 'Manage plugin')}
          </Button>
        ) : null}
      </div>
      {panel && enabled ? (
        <>
          <SettingsGroup title={panel.title} bodyClassName="px-0">
            <div className="flex min-h-64 flex-col">
              <PluginPanel
                tabKey={panel.tabKey}
                location="settings"
                onSettingsChanged={onSettingsChanged}
              />
            </div>
          </SettingsGroup>
          {plugin.hasSettings ? (
            <Collapsible>
              <CollapsibleTrigger variant="row">
                {t('pluginIntegrations.advanced', 'Advanced settings')}
                <ChevronDown className="size-4 text-muted-foreground group-data-[state=open]:rotate-180 motion-reduce:transform-none" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <PluginSettingsSection
                  pluginKey={pluginKey}
                  revision={`${plugin.version}:${plugin.devChangeCount ?? 0}`}
                  settingsRevision={settingsRevision}
                  draftRevisions={draftRevisions}
                  presentation="settings"
                />
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </>
      ) : (
        <SettingsGroup
          title={t('pluginIntegrations.unavailableTitle', 'Plugin integration unavailable')}
        >
          <div data-settings-row="" className="space-y-3 py-4">
            <p className="text-sm text-muted-foreground">
              {t(
                'pluginIntegrations.unavailable',
                'This plugin was removed, disabled, or could not be loaded. Manage it in Plugins, then return to Integrations.'
              )}
            </p>
            <Button variant="outline" size="sm" onClick={openPluginsSettings}>
              {t('pluginIntegrations.manage', 'Manage plugin')}
            </Button>
          </div>
        </SettingsGroup>
      )}
    </div>
  )
}
