// Settings › Bots: this computer's default for how long finished run chats stay open.
import { useId } from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  BOT_RUN_CHAT_CLOSE_CHOICES as CHOICES,
  type BotRunChatCloseAfter
} from '../../../../../shared/bots/bot-run-chat-close'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { useTranslate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { LOCAL_SETTINGS_HOST_SCOPE } from '../host-scope/settings-host-scope'
import {
  getHostSettingUpdateFailedMessage,
  useHostSetting,
  useSettingsHostLabel
} from '../host-scope/use-host-setting'
import { botRunChatCloseLabel, botRunChatCloseTitle } from '../../bots/bot-run-chat-close-copy'

export function BotRunChatCloseDefaultSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const labelId = useId()
  // Bots on a server follow that server's own default, like its other host settings.
  const hostLabel = useSettingsHostLabel(LOCAL_SETTINGS_HOST_SCOPE.target)
  const { setting, update } = useHostSetting({
    owner: LOCAL_SETTINGS_HOST_SCOPE.target,
    settingKey: 'botRunChatsCloseAfter',
    localSettings: settings,
    updateLocalSettings: updateSettings,
    updateFailedMessage: getHostSettingUpdateFailedMessage(hostLabel, t)
  })
  const value = setting.state === 'ready' ? setting.value : null
  const overrides = useBots().flatMap((bot) =>
    bot.hostId === LOCAL_EXECUTION_HOST_ID && bot.runChatsCloseAfter
      ? [`${bot.name} (${botRunChatCloseLabel(bot.runChatsCloseAfter, t)})`]
      : []
  )
  return (
    <SettingsRow
      label={botRunChatCloseTitle(t)}
      labelId={labelId}
      description={
        <>
          {t(
            'bots.runChatClose.defaultDescription',
            'Closes finished chats from automations that start a new conversation each run. Never closes Home Chats, chats linked to a thread, handoff chats, or a chat that is still working. History stays in Session History.'
          )}
          {overrides.length > 0 ? (
            <span className="mt-1 block">
              {t('bots.runChatClose.overriddenBy', 'Overridden by {{bots}}.', {
                bots: overrides.join(', ')
              })}
            </span>
          ) : null}
        </>
      }
      control={
        <Select
          value={value ?? ''}
          disabled={value === null}
          onValueChange={(next) => {
            const choice = CHOICES.find((entry) => entry === next)
            if (choice) {
              void update(choice satisfies BotRunChatCloseAfter)
            }
          }}
        >
          <SelectTrigger size="sm" className="min-w-32" aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHOICES.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {botRunChatCloseLabel(choice, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}
