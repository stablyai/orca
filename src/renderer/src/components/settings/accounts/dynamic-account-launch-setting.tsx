import { useTranslate } from '@/i18n/use-translate'
import {
  DEFAULT_DYNAMIC_ACCOUNT_MARGIN_PERCENT,
  MAX_DYNAMIC_ACCOUNT_MARGIN_PERCENT,
  dynamicAccountMarginPercent
} from '../../../../../shared/dynamic-account-launch-settings'
import { NumberField, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroupNestedRows } from '../section-layout/SettingsGroup'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

export function DynamicAccountLaunchSetting({
  provider,
  model
}: {
  provider: 'claude' | 'codex'
  model: Pick<
    AccountsPaneSectionModel,
    | 'isRemoteAccountScope'
    | 'settings'
    | 'updateSettings'
    | 'visibleClaudeAccounts'
    | 'visibleCodexAccounts'
  >
}): React.JSX.Element | null {
  const t = useTranslate()
  const { isRemoteAccountScope, settings, updateSettings } = model
  const enabled =
    (provider === 'claude'
      ? settings.claudeDynamicAccountLaunch
      : settings.codexDynamicAccountLaunch) === true
  const accounts = provider === 'claude' ? model.visibleClaudeAccounts : model.visibleCodexAccounts
  // Stays visible while on, so it can be turned off after removing accounts.
  if (isRemoteAccountScope || (accounts.length < 2 && !enabled)) {
    return null
  }
  const title = t('accounts.dynamicLaunch.title', 'Pick an account for each new session')
  const description = t(
    'accounts.dynamicLaunch.description',
    'Uses the account whose weekly limit resets soonest, keeping a margin free on every account.'
  )
  // Without usage polling, inactive Claude accounts have no readings to pick from.
  const needsUsagePolling = provider === 'claude' && settings.claudeOAuthUsageEnabled === false
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[provider, 'account', 'dynamic', 'quota']}
    >
      <SettingsSwitchRow
        label={title}
        description={
          needsUsagePolling
            ? t(
                'accounts.dynamicLaunch.needsUsagePolling',
                'Turn on Claude usage polling below to use this.'
              )
            : description
        }
        checked={enabled}
        disabled={needsUsagePolling && !enabled}
        onChange={() =>
          updateSettings(
            provider === 'claude'
              ? { claudeDynamicAccountLaunch: !enabled }
              : { codexDynamicAccountLaunch: !enabled }
          )
        }
      />
      {enabled ? (
        <SettingsGroupNestedRows>
          <NumberField
            label={t('accounts.dynamicLaunch.margin', 'Margin to keep on each account (%)')}
            description={t('accounts.dynamicLaunch.marginScope', 'Applies to Claude and Codex.')}
            value={dynamicAccountMarginPercent(settings)}
            defaultValue={DEFAULT_DYNAMIC_ACCOUNT_MARGIN_PERCENT}
            min={0}
            max={MAX_DYNAMIC_ACCOUNT_MARGIN_PERCENT}
            integer
            onChange={(value) => updateSettings({ dynamicAccountMarginPercent: value })}
          />
        </SettingsGroupNestedRows>
      ) : null}
    </SearchableSetting>
  )
}
