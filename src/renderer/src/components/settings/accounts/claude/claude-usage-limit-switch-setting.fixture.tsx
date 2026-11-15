import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { useAppStore } from '../../../../store'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { ClaudeRunningSessionSwitchSetting } from './claude-running-session-switch-setting'
import { ClaudeUsageLimitSwitchSetting } from './claude-usage-limit-switch-setting'

function UsageLimitSwitchFixture(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  if (!settings) {
    return null
  }
  return (
    <div className="settings-view-shell bg-background p-8 text-foreground">
      <SettingsGroup title="Claude">
        <ClaudeRunningSessionSwitchSetting settings={settings} updateSettings={updateSettings} />
        <ClaudeUsageLimitSwitchSetting settings={settings} updateSettings={updateSettings} />
      </SettingsGroup>
    </div>
  )
}

export const off = defineFixture({ width: 720, render: () => <UsageLimitSwitchFixture /> })

export const on = defineFixture({
  ...off,
  store: {
    settings: { ...getDefaultSettings('/fixture'), claudeAccountSwitchAtUsageLimit: true }
  }
})

export const narrow = defineFixture({ ...on, width: 360 })
