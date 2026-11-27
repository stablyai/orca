import React, { useState } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { DiscordIcon } from '@/components/icons/DiscordIcon'
import type { IntegrationCardStatusTone } from '@/components/integrations/presentation/integration-card-shell'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { botDiscordCalls } from '@/lib/bot-connector-host-calls'
import { botDiscordState, type BotDiscordView, useBotDiscordHost } from '@/lib/bot-discord-state'
import type { Bot, BotDiscordGuild } from '../../../../../shared/bot-types'
import {
  BOT_DISCORD_OFF,
  type ConnectorBotDiscordState
} from '../../../../../shared/connector-bot-discord-contract'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'
import { BotConnectorSection } from '../bot-connector-people'
import { BotConnectorRow } from '../BotConnectorRow'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { BotHowToAsk } from '../BotHowToAsk'
import { BotWhoCanAskList, type BotWhoCanAskService } from '../BotWhoCanAskList'
import { signedOutConnectorFace } from '../orca-cloud-sign-in'
import { useBotHostLabel } from '../use-bot-host-label'
import { botDiscordErrorMessage, discordHowToAsk, discordMention } from './bot-discord-copy'
import { BotDiscordSetupDialog } from './BotDiscordSetupDialog'
import { DiscordGuildLimits } from './DiscordGuildLimits'
import { useDiscordWhoCanAsk } from './use-discord-who-can-ask'

type DiscordCardFace = {
  description: string
  status: { label: string; tone: IntegrationCardStatusTone } | null
  /** The bot's Discord bot works and is in this server. */
  reachable: boolean
}

const attention = (label: string): DiscordCardFace['status'] => ({ label, tone: 'attention' })

/** One row of the bot's Discord: a server it is in, or (null) its Discord bot before it joins one. */
export function discordCardFace(
  bot: Pick<Bot, 'id' | 'name'>,
  guild: BotDiscordGuild | null,
  view: BotDiscordView,
  hostName: string | null
): DiscordCardFace {
  if (view.status === 'loading') {
    return {
      description: discordMention(bot),
      status: {
        label: translate('settings.bots.discordStatus.checking', 'Checking'),
        tone: 'neutral'
      },
      reachable: false
    }
  }
  if (view.status === 'failed' && view.error === BOT_SLACK_DESKTOP_ERRORS.signedOut) {
    return { ...signedOutConnectorFace(), reachable: false }
  }
  if (view.status !== 'ready') {
    return {
      description: botDiscordErrorMessage(
        view.status === 'off' ? BOT_DISCORD_OFF : view.error,
        hostName
      ),
      status: {
        label: translate('settings.bots.discordStatus.unknown', 'Can’t check'),
        tone: 'neutral'
      },
      reachable: false
    }
  }
  const state = botDiscordState(view, bot.id)
  if (state.state !== 'ready') {
    return {
      description:
        state.state === 'broken' && state.reason === 'token_revoked'
          ? translate(
              'bots.discord.connection.tokenRevoked',
              'Discord no longer accepts its bot token. Paste a new one.'
            )
          : translate(
              'bots.discord.connection.setUpAgain',
              'Its Discord bot stopped answering. Set it up again.'
            ),
      status: attention(translate('settings.bots.discordStatus.needsToken', 'Needs a new token')),
      reachable: false
    }
  }
  if (guild === null) {
    return {
      description: translate(
        'bots.discord.connection.noServer',
        'Add {{name}} to a server so people can reach it.',
        { name: state.botName || bot.name }
      ),
      status: attention(translate('settings.bots.discordStatus.noServer', 'Not in a server')),
      reachable: false
    }
  }
  return { description: discordMention(bot, state.botName), status: null, reachable: true }
}

function discordOwner(state: ConnectorBotDiscordState): { id: string | null; name: string | null } {
  return state.state === 'ready'
    ? { id: state.ownerUserId ?? null, name: state.ownerName ?? null }
    : { id: null, name: null }
}

/** One Discord row's state and its people, for the row and for Who can ask. */
export function useDiscordCard(
  bot: Bot,
  guild: BotDiscordGuild | null
): { view: BotDiscordView; face: DiscordCardFace; people: BotWhoCanAskService; botName: string } {
  const view = useBotDiscordHost(bot.hostId)
  const hostName = useBotHostLabel(bot.hostId)
  const face = discordCardFace(bot, guild, view, hostName)
  const state = botDiscordState(view, bot.id)
  const people = useDiscordWhoCanAsk(
    bot,
    guild ?? { guildId: '', guildName: '' },
    discordOwner(state),
    face.reachable
  )
  return { view, face, people, botName: state.state === 'ready' ? state.botName : '' }
}

/** Settings › Bots › Connectors › Discord: one server the bot is in, how to ask it there, who can, and where. */
export function BotDiscordCard({
  bot,
  guild,
  title,
  defaultOpen
}: {
  bot: Bot
  /** Null: the bot's Discord bot is not in a server yet. */
  guild: BotDiscordGuild | null
  title?: BotConnectorTitle
  defaultOpen?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const hostName = useBotHostLabel(bot.hostId)
  const { view, face, people, botName } = useDiscordCard(bot, guild)
  const [setupOpen, setSetupOpen] = useState<'repair' | 'add' | null>(null)
  const server = guild ? guild.guildName || guild.guildId : null

  const remove = async (): Promise<void> => {
    const place = server ?? 'Discord'
    const confirmed = await confirm({
      title: t('bots.slack.connection.removeFromTitle', 'Remove {{name}} from {{place}}?', {
        name: bot.name,
        place
      }),
      description: guild
        ? t(
            'bots.discord.connection.leaveNote',
            'Its Discord bot leaves {{server}}, and its people and limits there are cleared.',
            { server: place }
          )
        : t(
            'bots.discord.connection.removeNote',
            'Orca Cloud forgets its bot token. The application stays in your Developer Portal.'
          ),
      confirmLabel: t('bots.discord.connection.removeConfirm', 'Remove'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    const calls = botDiscordCalls(bot.hostId)
    const removed = guild
      ? await calls.leaveGuild({ botId: bot.id, guildId: guild.guildId })
      : await calls.remove({ botId: bot.id })
    if (!removed.ok) {
      toast.error(botDiscordErrorMessage(removed.error, hostName))
    }
  }

  const howToAsk = discordHowToAsk(bot, botName)
  return (
    <BotConnectorRow
      connector={{ id: 'discord', Icon: DiscordIcon }}
      name={title ?? 'Discord'}
      description={face.description}
      status={face.status}
      checking={view.status === 'loading'}
      fix={
        face.status?.tone === 'attention'
          ? {
              label: t('bots.discord.connection.finishSetup', 'Finish setup'),
              onClick: () => setSetupOpen('repair')
            }
          : null
      }
      bot={bot}
      howToAsk={howToAsk}
      people={people}
      defaultOpen={defaultOpen}
      add={{
        label: t('bots.discord.connection.addServer', 'Add to another server'),
        onClick: () => setSetupOpen('add')
      }}
      remove={{
        label: t('bots.connector.removeFrom', 'Remove from {{place}}…', {
          place: server ?? 'Discord'
        }),
        onSelect: () => void remove()
      }}
      body={
        guild ? (
          <>
            <BotConnectorSection title={t('bots.connector.howToAsk', 'How to ask')}>
              <p className="mb-4 text-xs leading-5 text-muted-foreground">
                <BotHowToAsk text={howToAsk} />
              </p>
            </BotConnectorSection>
            <BotWhoCanAskList bot={bot} service={people} />
            <DiscordGuildLimits bot={bot} guild={guild} />
          </>
        ) : (
          <p className="mb-4 text-xs leading-5 text-muted-foreground">{face.description}</p>
        )
      }
    >
      <BotDiscordSetupDialog
        bot={bot}
        guildId={setupOpen === 'repair' ? guild?.guildId : undefined}
        open={setupOpen !== null}
        onOpenChange={(open) => setSetupOpen(open ? (setupOpen ?? 'add') : null)}
      />
    </BotConnectorRow>
  )
}
