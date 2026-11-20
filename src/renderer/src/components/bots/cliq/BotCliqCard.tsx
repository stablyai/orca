import React, { useState } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { CliqIcon } from '@/components/icons/CliqIcon'
import type { IntegrationCardStatusTone } from '@/components/integrations/presentation/integration-card-shell'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { type BotCliqView, useBotCliq } from '@/lib/bot-cliq-state'
import { botCliqCalls } from '@/lib/bot-connector-host-calls'
import type { Bot, BotCliqBot } from '../../../../../shared/bot-types'
import { BOT_CLIQ_OFF, cliqWebUrl } from '../../../../../shared/connector-bot-cliq-contract'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'
import { connectorAddAccessLabel } from '../bot-connectors'
import { useConnectorSetup } from '../ConnectorSetupDialogs'
import { BotConnectorRow } from '../BotConnectorRow'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { useBotHostLabel } from '../use-bot-host-label'
import type { BotWhoCanAskService } from '../BotWhoCanAskList'
import { signedOutConnectorFace } from '../orca-cloud-sign-in'
import { botCliqErrorMessage, cliqHowToAsk } from './bot-cliq-copy'
import { BotCliqSetupDialog } from './BotCliqSetupDialog'
import type { CliqSignIn } from './cliq-setup-step'
import { useCliqWhoCanAsk } from './use-cliq-who-can-ask'

type CliqCardFace = {
  description: string
  status: { label: string; tone: IntegrationCardStatusTone } | null
  /** The owner's Zoho sign-in in the bot's organization, while the cloud has one. */
  signIn: CliqSignIn | null
}

export function cliqCardFace(
  cliq: BotCliqBot,
  view: BotCliqView,
  hostName: string | null
): CliqCardFace {
  const description = cliqWebUrl(cliq.dataCenter).replace('https://', '')
  if (view.status === 'loading') {
    return {
      description,
      status: {
        label: translate('settings.bots.cliqStatus.checking', 'Checking'),
        tone: 'neutral'
      },
      signIn: null
    }
  }
  if (view.status === 'failed' && view.error === BOT_SLACK_DESKTOP_ERRORS.signedOut) {
    return { ...signedOutConnectorFace(), signIn: null }
  }
  if (view.status !== 'ready') {
    return {
      description: botCliqErrorMessage(view.status === 'off' ? BOT_CLIQ_OFF : view.error, hostName),
      status: {
        label: translate('settings.bots.cliqStatus.unknown', 'Can’t check'),
        tone: 'neutral'
      },
      signIn: null
    }
  }
  const signIn = view.cliq.orgs.find((entry) => entry.orgId === cliq.orgId) ?? null
  if (!signIn || signIn.expired) {
    return {
      description: translate(
        'bots.cliq.connection.signedOut',
        'Sign in to Zoho again so {{org}} can reach the bot.',
        { org: cliq.orgName || cliq.orgId }
      ),
      status: {
        label: translate('settings.bots.cliqStatus.signInNeeded', 'Sign-in needed'),
        tone: 'attention'
      },
      signIn
    }
  }
  return { description, status: null, signIn }
}

/** One Cliq row's state and its people, for the row and for Who can ask. */
export function useCliqCard(
  bot: Bot,
  cliq: BotCliqBot
): { view: BotCliqView; face: CliqCardFace; people: BotWhoCanAskService } {
  const view = useBotCliq(bot.hostId)
  const hostName = useBotHostLabel(bot.hostId)
  const face = cliqCardFace(cliq, view, hostName)
  const people = useCliqWhoCanAsk(bot, cliq, face.signIn)
  return { view, face, people }
}

/** Settings › Bots › Connectors › Zoho Cliq: the bot's Cliq organization, how to ask it, and who can. */
export function BotCliqCard({
  bot,
  cliq,
  title,
  defaultOpen
}: {
  bot: Bot
  cliq: BotCliqBot
  title?: BotConnectorTitle
  defaultOpen?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const hostName = useBotHostLabel(bot.hostId)
  const { view, face, people } = useCliqCard(bot, cliq)
  const [setupOpen, setSetupOpen] = useState(false)
  const addAccess = useConnectorSetup(bot)
  const org = cliq.orgName || cliq.orgId

  const remove = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('bots.slack.connection.removeFromTitle', 'Remove {{name}} from {{place}}?', {
        name: bot.name,
        place: org
      }),
      description: t(
        'bots.cliq.connection.removeNote',
        'Orca deletes the {{name}} bot from {{org}}’s Cliq, and its Cliq people are cleared.',
        { name: bot.name, org }
      ),
      confirmLabel: t('bots.cliq.connection.removeConfirm', 'Remove'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    const removed = await botCliqCalls(bot.hostId).remove({ botId: bot.id, orgId: cliq.orgId })
    if (!removed.ok) {
      toast.error(botCliqErrorMessage(removed.error, hostName))
    }
  }

  return (
    <BotConnectorRow
      connector={{ id: 'cliq', Icon: CliqIcon }}
      name={title ?? 'Zoho Cliq'}
      description={face.description}
      status={face.status}
      checking={view.status === 'loading'}
      fix={
        face.status?.tone === 'attention'
          ? {
              label: t('bots.cliq.connection.finishSetup', 'Finish setup'),
              onClick: () => setSetupOpen(true)
            }
          : null
      }
      bot={bot}
      howToAsk={cliqHowToAsk(bot)}
      people={people}
      defaultOpen={defaultOpen}
      add={{ label: connectorAddAccessLabel('cliq'), onClick: () => addAccess.start('cliq') }}
      remove={{
        label: t('bots.connector.removeFrom', 'Remove from {{place}}…', { place: org }),
        onSelect: () => void remove()
      }}
    >
      <BotCliqSetupDialog
        bot={bot}
        orgId={cliq.orgId}
        open={setupOpen}
        onOpenChange={setSetupOpen}
      />
      {addAccess.dialogs}
    </BotConnectorRow>
  )
}
