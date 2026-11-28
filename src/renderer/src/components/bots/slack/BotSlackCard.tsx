import React, { useState } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { SlackIcon } from '@/components/icons/SlackIcon'
import { useTranslate } from '@/i18n/use-translate'
import { refreshBotSlack, slackTeamState, useBotSlack } from '@/lib/bot-slack-state'
import { botSlackCalls } from '@/lib/bot-connector-host-calls'
import { openBotHostPageOrSay } from '@/lib/bot-host-page'
import type { Bot } from '../../../../../shared/bot-types'
import { connectorAddAccessLabel } from '../bot-connectors'
import { useConnectorSetup } from '../ConnectorSetupDialogs'
import { BotConnectorRow, type BotConnectorFix } from '../BotConnectorRow'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { botSlackErrorMessage, slackHowToAsk } from './bot-slack-copy'
import { useBotHostLabel } from '../use-bot-host-label'
import { BotSlackSetupDialog } from './BotSlackSetupDialog'
import { BotSlackSection } from './BotSlackSection'
import { useSlackWhoCanAsk } from './use-slack-who-can-ask'
import { slackCardFace, type SlackCardFace } from './bot-slack-card-face'

export { slackCardFace }

function slackAppSettingsUrl(appId: string): string {
  return `https://api.slack.com/apps/${encodeURIComponent(appId)}`
}

/**
 * Settings › Bots › Connectors › one Slack workspace: the bot's app there, how to ask it, and its
 * people there with access. No team: a bot whose app was removed but whose Slack people remain.
 */
export function BotSlackCard({
  bot,
  teamId,
  title,
  defaultOpen
}: {
  bot: Bot
  teamId?: string
  /** The row's title from the bot's connector list; see botConnectorTitles. */
  title?: BotConnectorTitle
  defaultOpen?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const view = useBotSlack(bot)
  const confirm = useConfirmationDialog()
  const [setupOpen, setSetupOpen] = useState(false)
  // Another workspace, through the same setup as Add connector.
  const addAccess = useConnectorSetup(bot)
  const [removing, setRemoving] = useState(false)
  const hostName = useBotHostLabel(bot.hostId)
  const face = slackCardFace(view, teamId, hostName)
  const people = useSlackWhoCanAsk(bot, teamId)
  const team = view.status === 'ready' ? slackTeamState(view.slack, teamId) : null
  const installed = team?.state === 'installed' ? team : null
  // A workspace's row can also remove an app that was never installed.
  const removable = installed ?? (teamId !== undefined && team && 'teamId' in team ? team : null)

  const remove = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('bots.slack.connection.removeFromTitle', 'Remove {{name}} from {{place}}?', {
        name: bot.name,
        place: face.workspace ?? 'Slack'
      }),
      description: t(
        'bots.slack.connection.removeNote',
        'Removing stops new work from Slack. It does not delete the app in Slack.'
      ),
      confirmLabel: t('bots.slack.connection.removeConfirm', 'Remove'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    setRemoving(true)
    const result = await botSlackCalls(bot.hostId).remove({
      botId: bot.id,
      teamId: removable?.teamId
    })
    setRemoving(false)
    if (!result.ok) {
      toast.error(botSlackErrorMessage(result.error, hostName))
    }
    await refreshBotSlack(bot)
  }

  const openSetup = (): void => setSetupOpen(true)
  const fixes: Record<NonNullable<SlackCardFace['next']>, BotConnectorFix> = {
    retry: {
      label: t('bots.slack.setup.retry', 'Try again'),
      onClick: () => void refreshBotSlack(bot)
    },
    add: { label: t('bots.slack.connection.add', 'Add to Slack'), onClick: openSetup },
    finish: {
      label: t('bots.slack.connection.finish', 'Finish setup'),
      onClick: openSetup
    },
    update: {
      label: t('bots.slack.connection.update', 'Update in Slack'),
      onClick: openSetup
    }
  }

  return (
    <BotConnectorRow
      connector={{ id: 'slack', Icon: SlackIcon }}
      name={title ?? 'Slack'}
      description={face.description}
      status={face.status}
      checking={view.status === 'loading'}
      fix={face.next ? fixes[face.next] : null}
      bot={bot}
      howToAsk={slackHowToAsk(bot)}
      people={people}
      body={installed ? <BotSlackSection bot={bot} slack={installed} /> : undefined}
      defaultOpen={defaultOpen}
      add={
        installed
          ? { label: connectorAddAccessLabel('slack'), onClick: () => addAccess.start('slack') }
          : null
      }
      link={
        installed
          ? {
              label: t('bots.slack.connection.appSettings', 'Slack app settings'),
              onClick: () =>
                openBotHostPageOrSay(bot.hostId, slackAppSettingsUrl(installed.appId), {
                  bot,
                  local: 'system'
                })
            }
          : null
      }
      update={
        installed?.updateAvailable && !installed.updateNeeded
          ? {
              label: t('bots.slack.connection.updatePermissions', 'Update Slack permissions…'),
              onClick: openSetup
            }
          : null
      }
      remove={
        removable
          ? {
              label: t('bots.connector.removeFrom', 'Remove from {{place}}…', {
                place: face.workspace ?? 'Slack'
              }),
              onSelect: () => void remove(),
              disabled: removing
            }
          : null
      }
    >
      <BotSlackSetupDialog bot={bot} teamId={teamId} open={setupOpen} onOpenChange={setSetupOpen} />
      {addAccess.dialogs}
    </BotConnectorRow>
  )
}
