import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import {
  DEFAULT_CLAUDE_AUTO_SWITCH_MIN_SESSION_HEADROOM,
  DEFAULT_CLAUDE_AUTO_SWITCH_MIN_WEEKLY_HEADROOM
} from '../../../../../../shared/claude-account-switch-settings'
import { translate } from '@/i18n/i18n'
import { NumberField, SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'

export function ClaudeAccountAutoSwitchSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const title = translate(
    'accounts.claude.autoSwitch.settingTitle',
    'Switch accounts automatically when usage runs low'
  )
  const description = translate(
    'accounts.claude.autoSwitch.settingDescription',
    'Selects the Claude account with the most usage left when the selected account drops below a minimum. Running sessions are handled as for a manual switch.'
  )
  const enabled = settings.claudeAccountAutoSwitch === true
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'account', 'switch', 'automatic', 'usage', 'limit', 'quota']}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={enabled}
        onChange={() => updateSettings({ claudeAccountAutoSwitch: !enabled })}
      />
      {enabled ? (
        <div className="space-y-2 pb-2">
          <NumberField
            label={translate(
              'accounts.claude.autoSwitch.minSessionLabel',
              'Minimum 5-hour usage left'
            )}
            description={translate(
              'accounts.claude.autoSwitch.minSessionDescription',
              'Switch when less than this share of the 5-hour limit is left.'
            )}
            value={
              settings.claudeAccountAutoSwitchMinSessionHeadroom ??
              DEFAULT_CLAUDE_AUTO_SWITCH_MIN_SESSION_HEADROOM
            }
            defaultValue={DEFAULT_CLAUDE_AUTO_SWITCH_MIN_SESSION_HEADROOM}
            min={0}
            max={100}
            integer
            suffix="%"
            onChange={(value) =>
              updateSettings({ claudeAccountAutoSwitchMinSessionHeadroom: value })
            }
          />
          <NumberField
            label={translate(
              'accounts.claude.autoSwitch.minWeeklyLabel',
              'Minimum weekly usage left'
            )}
            description={translate(
              'accounts.claude.autoSwitch.minWeeklyDescription',
              'Switch when less than this share of the weekly limit is left.'
            )}
            value={
              settings.claudeAccountAutoSwitchMinWeeklyHeadroom ??
              DEFAULT_CLAUDE_AUTO_SWITCH_MIN_WEEKLY_HEADROOM
            }
            defaultValue={DEFAULT_CLAUDE_AUTO_SWITCH_MIN_WEEKLY_HEADROOM}
            min={0}
            max={100}
            integer
            suffix="%"
            onChange={(value) =>
              updateSettings({ claudeAccountAutoSwitchMinWeeklyHeadroom: value })
            }
          />
        </div>
      ) : null}
    </SearchableSetting>
  )
}
