// Bot settings: how long this bot's finished run chats stay open, or its computer's default.
import { Archive } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget } from '@/lib/bot-hosts'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'
import { BOT_RUN_CHAT_CLOSE_CHOICES as CHOICES } from '../../../../../shared/bots/bot-run-chat-close'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import {
  getHostSettingUpdateFailedMessage,
  useHostSetting
} from '../../settings/host-scope/use-host-setting'
import { botRunChatCloseLabel, botRunChatCloseTitle } from '../bot-run-chat-close-copy'
import { useBotComputerName } from './BotComputerPage'
import { SettingsInsetGroup, SettingsInsetRow } from './BotSettingsRows'

const USE_DEFAULT = 'default'

export function BotRunChatCloseSettingsGroup({
  bot,
  update
}: {
  bot: Bot
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
}): React.JSX.Element | null {
  const t = useTranslate()
  const localDefault = useAppStore((state) => state.settings?.botRunChatsCloseAfter)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const computer = useBotComputerName(bot)
  const remote = bot.hostId !== 'local'
  // The bot's own computer closes its chats, so its default is that computer's.
  const { setting } = useHostSetting({
    owner: botTarget(bot),
    settingKey: 'botRunChatsCloseAfter',
    localSettings: { botRunChatsCloseAfter: localDefault },
    updateLocalSettings: updateSettings,
    updateFailedMessage: getHostSettingUpdateFailedMessage(computer, t)
  })
  // An older computer neither closes run chats nor takes the bot's choice.
  if (setting.state !== 'ready') {
    return null
  }
  const fallback = botRunChatCloseLabel(setting.value, t)
  const own = bot.runChatsCloseAfter
  const effective = own ?? setting.value
  const foot =
    effective === 'never'
      ? t(
          'bots.runChatClose.footNever',
          "This bot's finished run chats stay open until you close them."
        )
      : own
        ? t(
            'bots.runChatClose.footOverride',
            'Overrides the default ({{duration}}). History stays in Session History.',
            { duration: fallback }
          )
        : remote
          ? t(
              'bots.runChatClose.footDefaultOn',
              'Follows the default on {{computer}}. History stays in Session History.',
              { computer }
            )
          : t(
              'bots.runChatClose.footDefault',
              'Follows the default in Bots settings. History stays in Session History.'
            )
  return (
    <SettingsInsetGroup title={t('bots.runChatClose.group', 'Automation runs')} foot={foot}>
      <SettingsInsetRow
        icon={<Archive />}
        title={t('bots.runChatClose.shortTitle', 'Close after')}
        end={
          <Select
            value={own ?? USE_DEFAULT}
            onValueChange={(next) => {
              const choice = CHOICES.find((entry) => entry === next)
              void update({ runChatsCloseAfter: choice ?? null })
            }}
          >
            <SelectTrigger size="xs" aria-label={botRunChatCloseTitle(t)}>
              {/* Following the default reads as a value, not as the Use default action. */}
              <SelectValue>
                {own
                  ? botRunChatCloseLabel(own, t)
                  : t('bots.runChatClose.defaultValue', 'Default ({{duration}})', {
                      duration: fallback
                    })}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={USE_DEFAULT}>
                {t('bots.runChatClose.useDefault', 'Use default ({{duration}})', {
                  duration: fallback
                })}
              </SelectItem>
              <SelectSeparator />
              {CHOICES.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {botRunChatCloseLabel(choice, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </SettingsInsetGroup>
  )
}
