import React, { useState } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { SlackIcon } from '@/components/icons/SlackIcon'
import type { IntegrationCardStatusTone } from '@/components/integrations/presentation/integration-card-shell'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  type BotSlackView,
  refreshBotSlack,
  slackTeamState,
  useBotSlack
} from '@/lib/bot-slack-state'
import { botSlackCalls } from '@/lib/bot-connector-host-calls'
import { openBotHostPageOrSay } from '@/lib/bot-host-page'
import type { Bot } from '../../../../../shared/bot-types'
import { connectorAddAccessLabel } from '../bot-connectors'
import { useConnectorSetup } from '../ConnectorSetupDialogs'
import { BotConnectorRow, type BotConnectorFix } from '../BotConnectorRow'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'
import { botSlackErrorMessage, slackHowToAsk } from './bot-slack-copy'
import { useBotHostLabel } from '../use-bot-host-label'
import { BotSlackSetupDialog } from './BotSlackSetupDialog'
import { BotSlackSection } from './BotSlackSection'
import { signedOutConnectorFace } from '../orca-cloud-sign-in'
import { useSlackWhoCanAsk } from './use-slack-who-can-ask'

function slackAppSettingsUrl(appId: string): string {
  return `https://api.slack.com/apps/${encodeURIComponent(appId)}`
}

type SlackCardFace = {
  /** The workspace's name once Slack says it. */
  workspace: string | null
  description: string
  status: { label: string; tone: IntegrationCardStatusTone } | null
  // The one thing to do next, if anything.
  next: 'retry' | 'add' | 'finish' | 'update' | null
}

export function slackCardFace(
  view: BotSlackView,
  teamId: string | undefined,
  hostName: string | null
): SlackCardFace {
  const face = slackStateFace(view, teamId, hostName)
  const slack = view.status === 'ready' ? slackTeamState(view.slack, teamId) : null
  return {
    ...face,
    workspace: slack?.state === 'installed' ? (slack.teamName ?? slack.teamId) : null
  }
}

function slackStateFace(
  view: BotSlackView,
  teamId: string | undefined,
  hostName: string | null
): Omit<SlackCardFace, 'workspace'> {
  const notInstalled = {
    label: translate('settings.bots.slackStatus.notInstalled', 'Not installed'),
    tone: 'attention' as const
  }
  if (view.status === 'loading') {
    return {
      description: translate('bots.slack.setup.checking', 'Checking Slack…'),
      status: notInstalled,
      next: null
    }
  }
  // An installed Slack is still installed; only the cloud's answer waits on sign-in.
  if (view.status === 'failed' && view.error === BOT_SLACK_DESKTOP_ERRORS.signedOut) {
    return { ...signedOutConnectorFace(), next: null }
  }
  if (view.status === 'failed') {
    return {
      description: botSlackErrorMessage(view.error, hostName),
      status: {
        label: translate('settings.bots.slackStatus.unknown', 'Can’t check'),
        tone: 'neutral'
      },
      next: 'retry'
    }
  }
  const slack = slackTeamState(view.slack, teamId)
  switch (slack.state) {
    case 'installed':
      return {
        description: translate('bots.slack.connection.installedBy', 'installed by {{installer}}', {
          installer: slack.installerName ?? slack.installerUserId
        }),
        status: slack.updateNeeded
          ? {
              label: translate('settings.bots.slackStatus.updateNeeded', 'Update needed'),
              tone: 'attention'
            }
          : null,
        next: slack.updateNeeded ? 'update' : null
      }
    case 'created':
      return {
        description: translate(
          'bots.slack.connection.waiting',
          'Waiting for the install in Slack.'
        ),
        status: {
          label: translate('settings.bots.slackStatus.waiting', 'Waiting for install'),
          tone: 'attention'
        },
        next: 'finish'
      }
    case 'not_created':
      return {
        description: translate('bots.slack.connection.none', 'Not in Slack yet.'),
        status: notInstalled,
        next: 'add'
      }
    case 'uncertain':
    case 'grant_expired':
      return {
        description: translate('bots.slack.connection.unfinished', 'Slack setup did not finish.'),
        status: notInstalled,
        next: 'finish'
      }
  }
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
      teamId: installed?.teamId
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
      remove={
        installed
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
