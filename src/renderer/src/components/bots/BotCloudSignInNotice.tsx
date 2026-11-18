// The bot's one quiet line about Orca sign-in, atop its connectors: signed out, or a sign-in the cloud refused.
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useConnectorNeedsSignIn } from '@/lib/bot-catalog'
import { refreshAccessRequests } from '@/lib/bot-access-requests'
import { refreshBotGitHub } from '@/lib/bot-github-state'
import { refreshBotLinear } from '@/lib/bot-linear-state'
import { refreshBotSlack } from '@/lib/bot-slack-state'
import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import { botLinearWorkspaces, botSlackApps, type Bot } from '../../../../shared/bot-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { OrcaCloudSignInLine } from './orca-cloud-sign-in'
import { useOrcaCloudSignedOut } from './orca-cloud-signed-out'

/** Reads again what a sign-in brings back: the bot's connectors, access requests and webhooks. */
export async function refreshBotCloudReads(bot: Pick<Bot, 'id' | 'hostId'>): Promise<void> {
  emitBotsChangedWindowEvent(bot.hostId)
  await Promise.all([
    refreshBotSlack(bot),
    refreshBotGitHub(bot.hostId),
    refreshBotLinear(bot.hostId),
    refreshAccessRequests()
  ])
}

/** Whether the bot has something that only works through Orca Cloud. */
function usesOrcaCloud(bot: Bot, webhooks: boolean): boolean {
  return (
    webhooks ||
    botSlackApps(bot).length > 0 ||
    bot.github !== null ||
    botLinearWorkspaces(bot).length > 0
  )
}

export function BotCloudSignInNotice({
  bot,
  webhooks
}: {
  bot: Bot
  /** The bot has a webhook. */
  webhooks: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const signedOut = useOrcaCloudSignedOut(bot.hostId)
  // Only this computer's refusal; a server's has its own notice.
  const refused =
    useConnectorNeedsSignIn(LOCAL_EXECUTION_HOST_ID) && bot.hostId === LOCAL_EXECUTION_HOST_ID
  const resume = (): Promise<void> => refreshBotCloudReads(bot)
  if (signedOut && usesOrcaCloud(bot, webhooks)) {
    return (
      <OrcaCloudSignInLine
        link
        className="px-2 py-1.5"
        text={t('bots.cloudSignIn.botOff', 'Signed out of Orca · Slack, events, sharing off')}
        onSignedIn={resume}
      />
    )
  }
  if (refused) {
    return (
      <OrcaCloudSignInLine
        className="px-2 py-1.5"
        text={t(
          'bots.connectors.signInChanged',
          'This computer’s Orca sign-in changed. Sign in again to reconnect.'
        )}
        onSignedIn={resume}
      />
    )
  }
  return null
}
