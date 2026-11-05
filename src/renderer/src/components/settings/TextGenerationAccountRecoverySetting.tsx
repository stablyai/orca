import { translate } from '@/i18n/i18n'
import { getAccountsTextRecoverySearchEntries } from './accounts-text-recovery-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import type { UsageHostSettingsModel } from './use-usage-host-settings'

export function TextGenerationAccountRecoverySetting({
  model,
  remote
}: {
  model: UsageHostSettingsModel
  remote: boolean
}) {
  const entry = getAccountsTextRecoverySearchEntries()[0]
  const description = translate(
    'settings.accounts.textRecovery.description',
    'When a subscription limit stops branch, workspace or chat names, commit messages, pull request details or Jira titles, retry on another saved account when supported. Keeps the chosen agent and model, using each account’s existing billing settings.'
  )
  const supported =
    !remote || model.settings?.textGenerationSubscriptionFailoverEnabled !== undefined
  return (
    <SearchableSetting title={entry.title} description={description} keywords={entry.keywords}>
      <SettingsSwitchRow
        label={entry.title}
        description={description}
        checked={model.settings?.textGenerationSubscriptionFailoverEnabled === true}
        disabled={!model.settings || !supported}
        onChange={() => {
          void model.update({
            textGenerationSubscriptionFailoverEnabled:
              model.settings?.textGenerationSubscriptionFailoverEnabled !== true
          })
        }}
      />
    </SearchableSetting>
  )
}
