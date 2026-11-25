// "Intro when added to a channel": whether the bot says how to ask it in a Slack channel a
// person adds it to. One switch for the bot, so every workspace's page shows the same one. Hidden
// while the bot's host's Orca Cloud doesn't honour it, since there the intro posts whatever it says.
import React from 'react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot, useBotSlackChannelHello } from '@/lib/bot-catalog'
import { botSlackApps, type Bot } from '../../../../../shared/bot-types'
import { useBotConnectorPaged } from '../bot-connector-page'
import { BotConnectorCaption } from '../bot-connector-people'
import { SettingsInsetGroup, SettingsInsetRow } from '../settings-view/BotSettingsRows'

export function BotSlackChannelIntro({ bot }: { bot: Bot }): React.JSX.Element | null {
  const t = useTranslate()
  const supported = useBotSlackChannelHello(bot.hostId)
  const paged = useBotConnectorPaged()
  if (!supported) {
    return null
  }
  const on = bot.slackChannelHello !== false
  const title = t('bots.slack.channelIntro.title', 'Intro when added to a channel')
  const detail =
    botSlackApps(bot).length > 1
      ? t(
          'bots.slack.channelIntro.detailEvery',
          'When someone adds {{name}} to a channel, it says how to ask it. In every Slack workspace {{name}} is in.',
          { name: bot.name }
        )
      : t(
          'bots.slack.channelIntro.detail',
          'When someone adds {{name}} to a channel, it says how to ask it.',
          { name: bot.name }
        )
  const change = (next: boolean): void => {
    // The shown list moves at once; a refused save is re-read from the host, never guessed back.
    updateBot(bot, { slackChannelHello: next }).catch((error: unknown) => {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('bots.slack.channelIntro.failed', 'Couldn’t save the intro setting.')
      )
    })
  }
  return (
    <div className={paged ? 'mt-3.5' : 'mt-3'}>
      <BotConnectorCaption title={t('bots.slack.channelIntro.caption', 'In channels')} />
      <SettingsInsetGroup className={paged ? '*:border *:border-border *:bg-card' : undefined}>
        <SettingsInsetRow
          title={title}
          detail={detail}
          wrapDetail
          end={
            <Switch
              size="compact"
              className="after:absolute after:-inset-2"
              checked={on}
              aria-label={title}
              onCheckedChange={change}
            />
          }
        />
      </SettingsInsetGroup>
    </div>
  )
}
