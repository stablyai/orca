import type { IntegrationCardStatusTone } from '@/components/integrations/presentation/integration-card-shell'
import { translate } from '@/i18n/i18n'
import type { BotLinearView } from '@/lib/bot-linear-state'
import type { BotLinear } from '../../../../../shared/bot-types'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'
import { signedOutConnectorFace } from '../orca-cloud-sign-in'
import { botLinearErrorMessage, linearWorkspaceLabel } from './bot-linear-copy'

export type LinearCardFace = {
  description: string
  status: { label: string; tone: IntegrationCardStatusTone } | null
  /** The owner's Linear account is linked in the bot's workspace, so its people can be searched. */
  linked: boolean
}

export function linearCardFace(
  linear: BotLinear,
  view: BotLinearView,
  hostName: string | null
): LinearCardFace {
  // The cloud's address when it has answered, so a bot saved before addresses were kept shows one too.
  const live =
    view.status === 'ready'
      ? view.linear.workspaces.find((entry) => entry.workspaceId === linear.workspaceId)
      : undefined
  const urlKey = live?.urlKey ?? linear.urlKey
  const workspaceLabel = linearWorkspaceLabel(linear.workspaceName, urlKey)
  // The workspace's name is the row's title; its address tells same-named ones apart.
  const description = urlKey ? `linear.app/${urlKey}` : linear.workspaceName
  if (view.status === 'loading') {
    return {
      description,
      status: {
        label: translate('settings.bots.linearStatus.checking', 'Checking'),
        tone: 'neutral'
      },
      linked: false
    }
  }
  if (view.status === 'failed' && view.error === BOT_SLACK_DESKTOP_ERRORS.signedOut) {
    return { ...signedOutConnectorFace(), linked: false }
  }
  if (view.status !== 'ready') {
    return {
      description: botLinearErrorMessage(
        view.status === 'off' ? 'linear_off' : view.error,
        hostName
      ),
      status: {
        label: translate('settings.bots.linearStatus.unknown', 'Can’t check'),
        tone: 'neutral'
      },
      linked: false
    }
  }
  const workspace = live
  if (!workspace) {
    return {
      description: translate(
        'bots.linear.connection.unlinked',
        'Finish setup to link your Linear account in {{workspace}}.',
        { workspace: workspaceLabel }
      ),
      status: {
        label: translate('settings.bots.linearStatus.unlinked', 'Not linked'),
        tone: 'attention'
      },
      linked: false
    }
  }
  return {
    description,
    status: workspace.installed
      ? null
      : {
          label: translate('settings.bots.linearStatus.notInstalled', 'Orca not installed'),
          tone: 'attention'
        },
    linked: true
  }
}
