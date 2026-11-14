import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/constants'
import { useAppStore } from '../../../store'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { DynamicAccountLaunchSetting } from './dynamic-account-launch-setting'

const account = {
  id: 'work',
  email: 'me@work.example',
  authMethod: 'subscription-oauth' as const,
  createdAt: 0,
  updatedAt: 0,
  lastAuthenticatedAt: 0
}
const accounts = [account, { ...account, id: 'personal', email: 'me@home.example' }]

function DynamicAccountLaunchFixture({
  provider
}: {
  provider: 'claude' | 'codex'
}): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  if (!settings) {
    return null
  }
  return (
    <div className="settings-view-shell bg-background p-8 text-foreground">
      <SettingsGroup title={provider === 'claude' ? 'Claude' : 'Codex'}>
        <DynamicAccountLaunchSetting
          provider={provider}
          model={{
            isRemoteAccountScope: false,
            settings,
            updateSettings,
            visibleClaudeAccounts: accounts,
            visibleCodexAccounts: accounts
          }}
        />
      </SettingsGroup>
    </div>
  )
}

export const off = defineFixture({
  width: 720,
  render: () => <DynamicAccountLaunchFixture provider="codex" />
})

export const on = defineFixture({
  width: 720,
  render: () => <DynamicAccountLaunchFixture provider="claude" />,
  store: { settings: { ...getDefaultSettings('/fixture'), claudeDynamicAccountLaunch: true } }
})

export const claudeUsagePollingOff = defineFixture({
  ...on,
  store: { settings: { ...getDefaultSettings('/fixture'), claudeOAuthUsageEnabled: false } }
})

export const narrow = defineFixture({ ...on, width: 360 })
