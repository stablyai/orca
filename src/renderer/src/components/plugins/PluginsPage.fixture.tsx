import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import type { PluginHostListEntry } from '../../../../shared/plugins/plugin-list-entry'
import { AppRail } from '../app-rail/AppRail'
import PluginsPage from './PluginsPage'
import { PluginsSettingsSection } from './list/PluginsSettingsSection'
import { ActiveSettingsSectionProvider } from '../settings/section-layout/SettingsSection'

// Clearly invented plugins: the page's shape only, no product data.
const entry = (
  pluginKey: string,
  name: string,
  status: 'idle' | 'disabled'
): PluginHostListEntry => ({
  pluginKey,
  consentFingerprint: 'fixture',
  name,
  version: '1.0.0',
  publisher: 'example',
  status,
  needsReconsent: false,
  isDev: false,
  official: false,
  bundled: false,
  capabilities: [],
  panels: [],
  commands: [],
  hasWorker: false,
  restarts: 0
})

const PLUGINS = [
  entry('example.alpha-theme', 'Example Theme', 'idle'),
  entry('example.beta-panel', 'Example Panel', 'idle'),
  entry('example.gamma-syntax', 'Example Syntax', 'disabled')
]

function setupWith(plugins: PluginHostListEntry[]): void {
  useAppStore.setState((state) => ({
    activeView: 'plugins',
    settings: state.settings
      ? {
          ...state.settings,
          experimentalAppRail: true,
          pluginSystemEnabled: true,
          showSkillsButton: true,
          showPluginsButton: true
        }
      : null
  }))
  window.api = {
    ...window.api,
    plugins: {
      ...window.api.plugins,
      list: async () => plugins,
      refresh: async () => plugins,
      onChanged: () => () => {},
      listMarketplaces: async () => [],
      listMarketplacePlugins: async () => [],
      getLogs: async () => []
    }
  }
}

const setup = (): void => setupWith(PLUGINS)

function Frame({ height }: { height: number }): React.JSX.Element {
  return (
    <div className="flex bg-worktree-sidebar" style={{ height }}>
      <div className="flex w-10 shrink-0 flex-col">
        <AppRail listVisible={false} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col pt-2">
        <PluginsPage />
      </div>
    </div>
  )
}

export const wide = defineFixture({ width: 1040, setup, render: () => <Frame height={620} /> })

export const narrow = defineFixture({ width: 520, setup, render: () => <Frame height={620} /> })

export const empty = defineFixture({
  width: 1040,
  setup: () => setupWith([]),
  render: () => <Frame height={620} />
})

export const longName = defineFixture({
  width: 520,
  setup: () =>
    setupWith([
      entry(
        'example.long-name',
        'Example plugin with a deliberately long name that has to truncate',
        'idle'
      )
    ]),
  render: () => <Frame height={620} />
})

function SettingsPane({ width }: { width: number }): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const updateSettingsOrThrow = useAppStore((s) => s.updateSettingsOrThrow)
  return settings ? (
    <ActiveSettingsSectionProvider value="plugins">
      <div className="bg-background p-8 text-foreground" style={{ width: width + 64 }}>
        <PluginsSettingsSection
          mounted
          settings={settings}
          updateSettings={updateSettingsOrThrow}
        />
      </div>
    </ActiveSettingsSectionProvider>
  ) : null
}

// Settings > Plugins at the rail page body's content width, to compare the two bodies.
export const settingsWide = defineFixture({
  width: 1040,
  setup,
  render: () => <SettingsPane width={910} />
})

export const settingsNarrow = defineFixture({
  width: 520,
  setup,
  render: () => <SettingsPane width={415} />
})
