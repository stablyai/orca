import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { useAppStore } from '../../../../store'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { ClaudeOAuthUsageSetting } from './claude-oauth-usage-setting'

function UsageSettingFixture(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  if (!settings) {
    return null
  }
  return (
    <div className="settings-view-shell bg-background p-8 text-foreground">
      <SettingsGroup title="Claude">
        <ClaudeOAuthUsageSetting
          settings={settings}
          updateSettings={updateSettings}
          recordFeatureInteraction={() => {}}
        />
      </SettingsGroup>
    </div>
  )
}

export const on = defineFixture({ width: 720, render: () => <UsageSettingFixture /> })

export const off = defineFixture({
  ...on,
  store: { settings: { ...getDefaultSettings('/fixture'), claudeOAuthUsageEnabled: false } }
})

export const narrow = defineFixture({ ...off, width: 360 })

export const infoTooltip = defineFixture({
  ...on,
  interact: (frame) => {
    frame
      .querySelector<HTMLButtonElement>('button[aria-label="About Claude usage polling"]')
      ?.focus()
  }
})
