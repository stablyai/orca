import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { useAppStore } from '../../../../store'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { ClaudeLimitAutoSwitchSetting } from './claude-limit-auto-switch-setting'

function AutoSwitchSettingFixture(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  if (!settings) {
    return null
  }
  return (
    <div className="settings-view-shell bg-background p-8 text-foreground">
      <SettingsGroup title="Claude">
        <ClaudeLimitAutoSwitchSetting settings={settings} updateSettings={updateSettings} />
      </SettingsGroup>
    </div>
  )
}

export const off = defineFixture({ width: 720, render: () => <AutoSwitchSettingFixture /> })

export const on = defineFixture({
  ...off,
  store: { settings: { ...getDefaultSettings('/fixture'), claudeAccountAutoSwitchAtLimit: true } }
})

export const pollingOff = defineFixture({
  ...off,
  store: {
    settings: {
      ...getDefaultSettings('/fixture'),
      claudeAccountAutoSwitchAtLimit: true,
      claudeOAuthUsageEnabled: false
    }
  }
})

export const narrow = defineFixture({ ...on, width: 360 })
