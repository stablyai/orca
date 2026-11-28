import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '../../../store'
import { antigravityAccountSwitchCopy } from '@/lib/provider-accounts/account-switch-copy'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { RunningSessionSwitchSetting } from './running-session-switch-setting'

// The setting as the Antigravity accounts section shows it, under its saved accounts.
function AntigravitySettingFixture(): React.JSX.Element {
  const value = useAppStore((state) => state.settings?.antigravityAccountSwitchRunningSessions)
  const updateSettings = useAppStore((state) => state.updateSettings)
  return (
    <div className="settings-view-shell bg-background p-8 text-foreground">
      <SettingsGroup
        title={
          <span className="flex items-center gap-2">
            <AgentIcon agent="antigravity" size={16} />
            Antigravity
          </span>
        }
      >
        <RunningSessionSwitchSetting
          copy={antigravityAccountSwitchCopy()}
          value={value}
          onChange={(next) =>
            void updateSettings({ antigravityAccountSwitchRunningSessions: next })
          }
        />
      </SettingsGroup>
    </div>
  )
}

export const antigravity = defineFixture({
  width: 720,
  render: () => <AntigravitySettingFixture />
})

export const antigravityNarrow = defineFixture({ ...antigravity, width: 360 })
