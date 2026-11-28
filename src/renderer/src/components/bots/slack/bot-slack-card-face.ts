import type { IntegrationCardStatusTone } from '@/components/integrations/presentation/integration-card-shell'
import { translate } from '@/i18n/i18n'
import { type BotSlackView, slackTeamState } from '@/lib/bot-slack-state'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'
import { signedOutConnectorFace } from '../orca-cloud-sign-in'
import { botSlackErrorMessage } from './bot-slack-copy'

export type SlackCardFace = {
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
