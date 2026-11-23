import React, { useState } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { LinearIcon } from '@/components/icons/LinearIcon'
import type { IntegrationCardStatusTone } from '@/components/integrations/presentation/integration-card-shell'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot } from '@/lib/bot-catalog'
import { type BotLinearView, useBotLinear } from '@/lib/bot-linear-state'
import {
  botLinearWorkspaces,
  botMemberSource,
  type Bot,
  type BotLinear
} from '../../../../../shared/bot-types'
import { connectorAddAccessLabel } from '../bot-connectors'
import { useConnectorSetup } from '../ConnectorSetupDialogs'
import { BotConnectorRow } from '../BotConnectorRow'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { botErrorMessage } from '../bot-presentation'
import { useBotHostLabel } from '../use-bot-host-label'
import { botLinearErrorMessage, linearHowToAsk, linearWorkspaceLabel } from './bot-linear-copy'
import { BotLinearSetupDialog } from './BotLinearSetupDialog'
import { useLinearWhoCanAsk } from './use-linear-who-can-ask'
import type { BotWhoCanAskService } from '../BotWhoCanAskList'
import { signedOutConnectorFace } from '../orca-cloud-sign-in'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'

type LinearCardFace = {
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

/** One Linear row's state and its people, for the row and for Who can ask. */
export function useLinearCard(
  bot: Bot,
  linear: BotLinear
): { view: BotLinearView; face: LinearCardFace; people: BotWhoCanAskService } {
  const view = useBotLinear(bot.hostId)
  const hostName = useBotHostLabel(bot.hostId)
  const face = linearCardFace(linear, view, hostName)
  const people = useLinearWhoCanAsk(bot.hostId, linear, face.linked)
  return { view, face, people }
}

/** Settings › Bots › Connectors › Linear: the bot's Linear workspace, how to ask it, and its Linear people with access. */
export function BotLinearCard({
  bot,
  linear,
  title,
  defaultOpen
}: {
  bot: Bot
  linear: BotLinear
  /** The row's title from the bot's connector list; see botConnectorTitles. */
  title?: BotConnectorTitle
  defaultOpen?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const { view, face, people } = useLinearCard(bot, linear)
  const [setupOpen, setSetupOpen] = useState(false)
  // Another workspace, through the same setup as Add connector.
  const addAccess = useConnectorSetup(bot)

  const remove = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('bots.slack.connection.removeFromTitle', 'Remove {{name}} from {{place}}?', {
        name: bot.name,
        place: linear.workspaceName
      }),
      description: t(
        'bots.linear.connection.removeNote',
        'People in {{workspace}} can no longer hand it issues, and its Linear people are cleared. Orca stays installed there.',
        { workspace: linearWorkspaceLabel(linear.workspaceName, linear.urlKey) }
      ),
      confirmLabel: t('bots.linear.connection.removeConfirm', 'Remove'),
      confirmVariant: 'destructive'
    })
    if (confirmed) {
      await updateBot(bot, {
        linearWorkspaces: botLinearWorkspaces(bot).filter(
          (entry) => entry.workspaceId !== linear.workspaceId
        ),
        members: bot.members.filter(
          (member) =>
            botMemberSource(member) !== 'linear' || member.workspaceId !== linear.workspaceId
        )
      }).catch((error: unknown) => toast.error(botErrorMessage(error)))
    }
  }

  return (
    <BotConnectorRow
      connector={{ id: 'linear', Icon: LinearIcon }}
      name={title ?? 'Linear'}
      description={face.description}
      status={face.status}
      checking={view.status === 'loading'}
      fix={
        face.status?.tone === 'attention'
          ? {
              label: t('bots.linear.connection.finishSetup', 'Finish setup'),
              onClick: () => setSetupOpen(true)
            }
          : null
      }
      bot={bot}
      howToAsk={linearHowToAsk(bot)}
      people={people}
      defaultOpen={defaultOpen}
      add={{ label: connectorAddAccessLabel('linear'), onClick: () => addAccess.start('linear') }}
      remove={{
        label: t('bots.connector.removeFrom', 'Remove from {{place}}…', {
          place: linear.workspaceName
        }),
        onSelect: () => void remove()
      }}
    >
      <BotLinearSetupDialog
        bot={bot}
        workspaceId={linear.workspaceId}
        open={setupOpen}
        onOpenChange={setSetupOpen}
      />
      {addAccess.dialogs}
    </BotConnectorRow>
  )
}
