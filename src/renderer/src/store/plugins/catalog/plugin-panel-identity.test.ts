import { expect, it } from 'vitest'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { collectActivePluginPanels } from './plugin-contribution-catalog'

function plugin(pluginKey: string, name: string, publisher: string): PluginHostListEntry {
  return {
    pluginKey,
    consentFingerprint: null,
    name,
    version: '1.0.0',
    publisher,
    status: 'running',
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    commands: [],
    hasWorker: false,
    restarts: 0,
    panels: [{ id: 'main', title: 'Dashboard', tabKey: `plugin:${pluginKey}/main` }]
  }
}

it('names two blank-named plugins of one publisher by their distinct plugin keys', () => {
  const panels = collectActivePluginPanels([
    plugin('acme.db', '', 'acme'),
    plugin('acme.logs', ' ', 'acme')
  ])
  // Why: the publisher is added only to a clashing name, so the key must be the name first.
  expect(panels.map((panel) => panel.pluginName)).toEqual(['acme.db', 'acme.logs'])
})

it('keeps the publisher on a named plugin that clashes with another plugin', () => {
  const panels = collectActivePluginPanels([
    plugin('acme.db', 'Dashboard', 'acme'),
    plugin('beta.db', 'Dashboard', 'beta')
  ])
  expect(panels.map((panel) => panel.pluginName)).toEqual(['Dashboard (acme)', 'Dashboard (beta)'])
})
