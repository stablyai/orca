import { defineFixture } from '../../../component-fixtures/component-fixture'
import { usePluginPanelsStore } from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { PluginIntegrationsGroup } from './PluginIntegrations'

const plugins: PluginHostListEntry[] = [
  {
    pluginKey: 'local.meego',
    name: 'Meego',
    publisher: 'local',
    version: '0.1.0',
    consentFingerprint: 'fixture',
    status: 'idle',
    needsReconsent: false,
    isDev: true,
    official: false,
    bundled: false,
    capabilities: [],
    commands: [],
    hasWorker: true,
    restarts: 0,
    panels: [
      {
        id: 'connection',
        title: '飞书项目（Meego）',
        icon: 'layers',
        location: 'settings',
        tabKey: 'plugin:local.meego/connection'
      }
    ]
  },
  {
    pluginKey: 'acme.calendar',
    name: 'Team Calendar',
    publisher: 'acme',
    version: '1.0.0',
    consentFingerprint: 'fixture',
    status: 'disabled',
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    commands: [],
    hasWorker: true,
    restarts: 0,
    panels: [
      {
        id: 'connection',
        title: 'Calendar connection',
        icon: 'calendar',
        location: 'settings',
        tabKey: 'plugin:acme.calendar/connection'
      }
    ]
  }
]

export const installed = defineFixture({
  width: 720,
  setup() {
    usePluginPanelsStore.getState().setPlugins(plugins)
  },
  render: () => (
    <div className="settings-view-shell p-8">
      <PluginIntegrationsGroup />
    </div>
  )
})
