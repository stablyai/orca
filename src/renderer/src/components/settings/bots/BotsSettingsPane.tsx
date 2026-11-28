import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../../../../shared/orca-profiles/orca-cloud-team-policy'
import { useTranslate } from '@/i18n/use-translate'
import { useOrcaTeamFeatureBlocked } from '@/lib/orca-team-policy'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { useBotSettingsAccounts, useBotSettingsComputers } from './bot-settings-computers'
import { BotAccountGroup, BotComputerGroup } from './BotSettingsGroups'

/** The bots switch and this computer's bot settings, then each Orca account and each computer with bots. */
export function BotsSettingsPane({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const computers = useBotSettingsComputers()
  const accounts = useBotSettingsAccounts(computers)
  const blocked = useOrcaTeamFeatureBlocked(ORCA_CLOUD_TEAM_POLICY_FLAGS.bots)
  const enabled = !blocked && settings.botsEnabled !== false
  const enableRow = (
    <SettingsSwitchRow
      label={t('settings.bots.enable', 'Enable bots')}
      description={
        blocked
          ? t('settings.bots.teamDisabled', 'Bots are turned off by your team.')
          : t(
              'settings.bots.enableDescription',
              'Shows bots on this computer, including bots on your servers, and lets this computer’s bots take messages and run automations. Turning this off hides them; their folders, memory and chats stay where they are.'
            )
      }
      checked={enabled}
      disabled={blocked}
      onChange={() => updateSettings({ botsEnabled: !enabled })}
    />
  )
  if (!enabled) {
    return enableRow
  }
  return (
    <div className="space-y-8">
      <div>
        {enableRow}
        <SettingsSwitchRow
          label={t('settings.bots.askNewHomeChat', 'Ask before a new Home Chat')}
          description={t(
            'settings.bots.askNewHomeChatDescription',
            'Confirm before New Home Chat replaces the conversation a bot carries.'
          )}
          checked={!settings.skipNewHomeChatConfirm}
          onChange={() =>
            updateSettings({ skipNewHomeChatConfirm: !settings.skipNewHomeChatConfirm })
          }
        />
      </div>
      <div className="space-y-6">
        {accounts.map((account) => (
          <BotAccountGroup key={account.email ?? ''} account={account} />
        ))}
        {computers.map((computer) => (
          <BotComputerGroup key={computer.hostId} computer={computer} />
        ))}
      </div>
    </div>
  )
}
