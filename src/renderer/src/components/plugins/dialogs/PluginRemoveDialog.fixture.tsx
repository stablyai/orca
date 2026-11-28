import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { PluginRemoveDialog } from './PluginRemoveDialog'

const plugin: PluginHostListEntry = {
  pluginKey: 'acme.tasks',
  name: 'Acme Tasks',
  publisher: 'acme',
  version: '1.0.0',
  consentFingerprint: 'fixture',
  status: 'idle',
  needsReconsent: false,
  isDev: false,
  official: false,
  bundled: false,
  capabilities: [],
  commands: [],
  panels: [],
  hasWorker: true,
  restarts: 0
}

export const installed = defineFixture({
  width: 480,
  render: () => (
    <PluginRemoveDialog plugin={plugin} busy={false} onCancel={() => {}} onConfirm={() => {}} />
  )
})

export const development = defineFixture({
  width: 480,
  render: () => (
    <PluginRemoveDialog
      plugin={{ ...plugin, isDev: true }}
      busy={false}
      onCancel={() => {}}
      onConfirm={() => {}}
    />
  )
})
