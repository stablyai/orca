import { useState } from 'react'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { AdvancedNetworkSettingsSection } from './AdvancedNetworkSettingsSection'

function NetworkSettingsFixture(): React.JSX.Element {
  const [settings, setSettings] = useState(() => ({
    ...getDefaultSettings('/fixture'),
    httpProxyUrl: 'http://proxy.example.invalid:8080'
  }))
  return (
    <div className="settings-view-shell bg-background p-8 text-foreground">
      <AdvancedNetworkSettingsSection
        settings={settings}
        updateSettings={(updates) => setSettings((current) => ({ ...current, ...updates }))}
      />
    </div>
  )
}

export const configured = defineFixture({
  width: 760,
  store: { settingsSearchQuery: '' },
  render: () => <NetworkSettingsFixture />
})

export const tlsSearch = defineFixture({
  width: 760,
  store: { settingsSearchQuery: 'tls' },
  render: () => <NetworkSettingsFixture />
})
