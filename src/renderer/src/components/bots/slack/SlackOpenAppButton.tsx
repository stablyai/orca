import React from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHostPageOrSay } from '@/lib/bot-host-page'
import type { Bot } from '../../../../../shared/bot-types'
import {
  slackAppMessagesUrl,
  type ConnectorBotSlackState
} from '../../../../../shared/connector-bot-slack-contract'

/** Opens the installed app's direct messages in Slack, so the first message is one click away.
 *  Nothing while the app isn't installed. */
export function SlackOpenAppButton({
  bot,
  slack,
  onOpenedInOrca
}: {
  bot: Pick<Bot, 'id' | 'name' | 'hostId'>
  slack: ConnectorBotSlackState | null | undefined
  /** The page opened in Orca's own browser, behind whatever shows this button. */
  onOpenedInOrca?: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (slack?.state !== 'installed') {
    return null
  }
  return (
    <Button
      variant="outline"
      onClick={() => {
        const opened = openBotHostPageOrSay(
          bot.hostId,
          slackAppMessagesUrl(slack.appId, slack.teamId),
          { bot, local: 'system' }
        )
        if (opened === 'orca-browser') {
          onOpenedInOrca?.()
        }
      }}
    >
      {t('bots.slack.setup.openInSlack', 'Message it in Slack')}
      <ExternalLink />
    </Button>
  )
}
