// One installed Slack workspace's body, the same in the connector panel and the after-install dialog:
// how to ask, Who can ask, who messages typed in Orca show as, and a picture Slack didn't get.
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import { BotHowToAsk, HOW_TO_ASK_ESCAPED } from '../BotHowToAsk'
import { BotWhoCanAskInsetList } from '../BotWhoCanAskInsetList'
import { useBotConnectorPaged } from '../bot-connector-page'
import { BotConnectorSection } from '../bot-connector-people'
import { BotSlackPostAs } from './BotSlackPostAs'
import { useSlackWhoCanAsk } from './use-slack-who-can-ask'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useBotSlackIconFailed } from '../bot-slack-icon-failures'
import { retryBotSlackIcon } from '../use-bot-slack-icons'

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
  // This window's last try at sending the bot's colored or dressed picture to Slack failed.
  const iconFailed = useBotSlackIconFailed(bot)
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
      {iconFailed ? (
        <BotConnectorSection>
          <div
            className={cn(
              'flex items-center justify-between gap-3 text-xs leading-5 text-muted-foreground',
              paged ? 'mb-3' : 'mt-3 px-3'
            )}
          >
            <span>
              {t(
                'bots.slack.iconFailed',
                "Slack didn't get {{name}}'s latest picture. It still shows the plain mascot.",
                { name: bot.name }
              )}
            </span>
            <Button size="xs" variant="outline" onClick={() => retryBotSlackIcon(bot)}>
              {t('bots.slack.iconRetry', 'Try again')}
            </Button>
          </div>
        </BotConnectorSection>
      ) : null}
      <BotConnectorSection>
        <BotSlackPostAs
          bot={bot}
          slack={slack}
          setupState={setupState}
          className={paged ? undefined : 'mt-3 px-3'}
        />
      </BotConnectorSection>
    </div>
  )
}
