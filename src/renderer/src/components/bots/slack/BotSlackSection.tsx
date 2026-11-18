// One installed Slack workspace's body, the same in the connector panel and the after-install dialog:
// how to ask, Who can ask, and who messages typed in Orca show as.
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import { BotHowToAsk, HOW_TO_ASK_ESCAPED } from '../BotHowToAsk'
import { BotWhoCanAskInsetList } from '../BotWhoCanAskInsetList'
import { BotSlackPostAs } from './BotSlackPostAs'
import { useSlackWhoCanAsk } from './use-slack-who-can-ask'

export function BotSlackSection({
  bot,
  slack,
  setupState
}: {
  bot: Bot
  slack: Extract<ConnectorBotSlackState, { state: 'installed' }>
  /** The after-install dialog's install link state: its identity pick applies at once. */
  setupState?: string
}): React.JSX.Element {
  const t = useTranslate()
  const people = useSlackWhoCanAsk(bot, slack.teamId)
  return (
    <div>
      <p className="mb-3 text-xs leading-5 text-muted-foreground">
        <BotHowToAsk
          text={t('bots.slack.mentionLine', 'Mention <code>@{{name}}</code> in a channel or DM.', {
            name: bot.name,
            ...HOW_TO_ASK_ESCAPED
          })}
        />
      </p>
      <BotWhoCanAskInsetList bot={bot} service={people} />
      <BotSlackPostAs bot={bot} slack={slack} setupState={setupState} />
    </div>
  )
}
