import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { botDiscordCalls } from '@/lib/bot-connector-host-calls'
import { useBotHostLabel } from '../use-bot-host-label'
import { discordMembersOf, type Bot, type BotDiscordGuild } from '../../../../../shared/bot-types'
import { CONNECTOR_CLIENT_LIMITS } from '../../../../../shared/connectors/connector-cloud-contract'
import type { BotWhoCanAskService } from '../BotWhoCanAskList'
import { botDiscordErrorMessage } from './bot-discord-copy'

/** A bot's Discord server row › People with access: the server's people the owner lets ask. `owner`
 *  is the application's owner in Discord, who always may; `reachable` once the bot works there. */
export function useDiscordWhoCanAsk(
  bot: Pick<Bot, 'id' | 'hostId'>,
  guild: BotDiscordGuild,
  owner: { id: string | null; name: string | null },
  reachable: boolean
): BotWhoCanAskService {
  const t = useTranslate()
  const hostName = useBotHostLabel(bot.hostId)
  const { guildId } = guild
  const server = guild.guildName || guildId
  return useMemo(
    (): BotWhoCanAskService => ({
      listed: (members) => discordMembersOf(members, guildId),
      stamp: { source: 'discord', workspaceId: guildId },
      max: CONNECTOR_CLIENT_LIMITS.maxBotWorkspaceMembers,
      search: (query) => botDiscordCalls(bot.hostId).members({ botId: bot.id, guildId, query }),
      errorMessage: (code) => botDiscordErrorMessage(code, hostName),
      searchPlaceholder: t('bots.whoCanAsk.searchIn', 'Search people in {{workspace}}', {
        workspace: server
      }),
      peopleHeading: t('bots.whoCanAsk.peopleIn', 'People in {{workspace}}', { workspace: server }),
      noMatch: (query) => ({
        title: t('bots.whoCanAsk.noOneNamed', 'No one named “{{query}}” in {{workspace}}', {
          query,
          workspace: server
        }),
        detail: t(
          'bots.discord.whoCanAsk.noMatchDetail',
          'Members of {{server}} can be added. To let a whole group ask, add their role below.',
          { server }
        )
      }),
      ownerId: owner.id,
      ownerName: owner.name,
      kind: 'discord',
      connector: 'Discord',
      workspace: server,
      outsiders: reachable
        ? t(
            'bots.discord.whoCanAsk.outsiders',
            'Everyone else in {{server}} is ignored, unless they hold a role below.',
            { server }
          )
        : null,
      notYet: t(
        'bots.discord.whoCanAsk.needsSetup',
        'Finish setup so {{server}} can reach the bot, then pick people here.',
        { server }
      )
    }),
    [bot.hostId, bot.id, hostName, guildId, server, owner.id, owner.name, reachable, t]
  )
}
