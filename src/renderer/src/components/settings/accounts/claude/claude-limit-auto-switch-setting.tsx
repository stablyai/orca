import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import {
  DEFAULT_ACCOUNT_AUTO_SWITCH_THRESHOLD_PERCENT,
  resolveAccountAutoSwitchThreshold
} from '../../../../../../shared/agent-usage/rate-limits/account-limit-auto-switch'
import { useTranslate } from '@/i18n/use-translate'
import { NumberField, SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'

export function ClaudeLimitAutoSwitchSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const enabled = settings.claudeAccountAutoSwitchAtLimit === true
  // Why: other accounts' usage is only read through usage polling.
  const pollingOff = settings.claudeOAuthUsageEnabled === false
  const title = t('accounts.claude.autoSwitch.title', 'Automatically switch account at limit')
  const description = pollingOff
    ? t(
        'accounts.claude.autoSwitch.needsPolling',
        'Turn on Claude usage polling so Orca can check your other accounts.'
      )
    : t(
        'accounts.claude.autoSwitch.description',
        'When the selected Claude account reaches the threshold, Orca selects the signed-in account with the most usage left.'
      )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'account', 'switch', 'automatic', 'limit', 'threshold', 'usage']}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={enabled && !pollingOff}
        disabled={pollingOff}
        onChange={() => updateSettings({ claudeAccountAutoSwitchAtLimit: !enabled })}
      />
      {enabled && !pollingOff ? (
        <NumberField
          label={t('accounts.claude.autoSwitch.threshold', 'Switch when usage reaches')}
          value={resolveAccountAutoSwitchThreshold(
            settings.claudeAccountAutoSwitchThresholdPercent
          )}
          defaultValue={DEFAULT_ACCOUNT_AUTO_SWITCH_THRESHOLD_PERCENT}
          min={1}
          max={100}
          integer
          suffix="%"
          onChange={(value) => updateSettings({ claudeAccountAutoSwitchThresholdPercent: value })}
        />
      ) : null}
    </SearchableSetting>
  )
}
