import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { useAppStore } from '../../../store'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { BrowserDefaultZoomSetting } from './BrowserDefaultZoomSetting'
import { BrowserMemorySaverSetting } from './BrowserMemorySaverSetting'

function MemorySaverFixture(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  if (!settings) {
    return null
  }
  return (
    <div className="settings-view-shell bg-background p-8 text-foreground">
      <SettingsGroup>
        <BrowserDefaultZoomSetting value={0} onChange={() => {}} />
        <BrowserMemorySaverSetting settings={settings} updateSettings={updateSettings} />
      </SettingsGroup>
    </div>
  )
}

export const on = defineFixture({ width: 720, render: () => <MemorySaverFixture /> })

export const customHours = defineFixture({
  ...on,
  store: { settings: { ...getDefaultSettings('/fixture'), browserMemorySaverHours: 8 } }
})

export const off = defineFixture({
  ...on,
  store: {
    settings: {
      ...getDefaultSettings('/fixture'),
      browserGuestWorktreeRetentionBudget: false,
      browserMemorySaverHours: 8
    }
  }
})
