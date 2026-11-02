import { defineFixture } from '../../component-fixtures/component-fixture'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import { buildPluginPanelShellHtml } from '../../../../shared/plugins/frames/plugin-panel-shell'
import PluginPanel from './PluginPanel'

export const compact = defineFixture({
  width: 280,
  setup() {
    usePluginPanelsStore.getState().setPlugins([
      {
        pluginKey: 'samples.layout',
        consentFingerprint: 'fixture',
        name: 'Layout',
        version: '1.0.0',
        publisher: 'samples',
        status: 'idle',
        needsReconsent: false,
        isDev: false,
        official: false,
        bundled: false,
        capabilities: [],
        panels: [{ id: 'panel', title: 'Layout', tabKey: 'plugin:samples.layout/panel' }],
        commands: [],
        hasWorker: false,
        restarts: 0
      }
    ])
    window.api = {
      ...window.api,
      plugins: {
        ...window.api.plugins,
        readPanelEntry: async () => ({
          html: buildPluginPanelShellHtml(
            '<body style="margin:0;color:var(--orca-foreground);background:var(--orca-background)"><div style="height:100vh;box-sizing:border-box;border:1px solid var(--orca-border);display:flex;align-items:end">Panel bottom</div></body>'
          ),
          sessionToken: 'fixture'
        })
      }
    }
  },
  render: () => (
    <div className="flex h-32 flex-col overflow-hidden">
      <div className="h-9 shrink-0 border-b border-border">Plugin sidebar</div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PluginPanel tabKey="plugin:samples.layout/panel" />
      </div>
    </div>
  )
})
