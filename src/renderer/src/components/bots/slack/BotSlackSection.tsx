// One installed Slack workspace's body, the same in the connector panel and the after-install dialog:
// how to ask, Who can ask, who messages typed in Orca show as, and whether their replies carry the
// link back to the thread in Orca.
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import { BotHowToAsk, HOW_TO_ASK_ESCAPED } from '../BotHowToAsk'
import { BotWhoCanAskInsetList } from '../BotWhoCanAskInsetList'
import { useBotConnectorPaged } from '../bot-connector-page'
import { BotConnectorSection } from '../bot-connector-people'
import { BotSlackPostAs } from './BotSlackPostAs'
import { BotSlackThreadLink } from './BotSlackThreadLink'
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
  // On the connector's own page each part is a captioned card; the dialog reads as one block.
  const paged = useBotConnectorPaged()
  return (
    <div>
      <BotConnectorSection title={paged ? t('bots.connector.howToAsk', 'How to ask') : undefined}>
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          <BotHowToAsk
            text={t(
              'bots.slack.mentionLine',
              'Mention <code>@{{name}}</code> in a channel or DM.',
              {
                name: bot.name,
                ...HOW_TO_ASK_ESCAPED
              }
            )}
          />
        </p>
      </BotConnectorSection>
      <BotWhoCanAskInsetList bot={bot} service={people} />
      <BotConnectorSection>
        <BotSlackPostAs
          bot={bot}
          slack={slack}
          setupState={setupState}
          className={paged ? undefined : 'mt-3 px-3'}
        />
        <BotSlackThreadLink
          bot={bot}
          slack={slack}
          className={paged ? 'mt-3' : 'mt-2 px-3'}
        />
      </BotConnectorSection>
    </div>
  )
}
