import { translate } from '@/i18n/i18n'
import type { Bot } from '../../../../../shared/bot-types'
import { BOT_DISCORD_OFF } from '../../../../../shared/connector-bot-discord-contract'
import { HOW_TO_ASK_ESCAPED } from '../BotHowToAsk'
import { hostSetupErrorMessage } from '../bot-host-copy'

/** What to tell the owner for a Discord error code, the cloud's or the host's; `hostName` names a server. */
export function botDiscordErrorMessage(code: string, hostName: string | null): string {
  const onHost = hostSetupErrorMessage(code, 'Discord', hostName)
  if (onHost) {
    return onHost
  }
  switch (code) {
    case BOT_DISCORD_OFF:
      return translate('bots.discord.errors.off', 'Discord is coming soon.')
    case 'discord_token_invalid':
      return translate(
        'bots.discord.errors.tokenInvalid',
        'Discord didn’t accept that token. Copy a new one from the Bot page of your application.'
      )
    case 'discord_token_in_use':
      return translate(
        'bots.discord.errors.tokenInUse',
        'Another of your bots already uses this Discord application. Make a new application for this one.'
      )
    case 'discord_refused':
      return translate(
        'bots.discord.errors.refused',
        'Discord refused. Check that the bot is still in the server, then try again.'
      )
    case 'discord_unavailable':
      return translate('bots.discord.errors.unavailable', 'Discord did not answer. Try again.')
    case 'rate_limited':
      return translate(
        'bots.discord.errors.rateLimited',
        'Too many tries. Wait a minute, then try again.'
      )
    case 'signed_out':
      return translate('bots.discord.errors.signedOut', 'Sign in to Orca to connect Discord.')
    case 'cloud_unreachable':
      return translate(
        'bots.discord.errors.unreachable',
        'Orca Cloud could not be reached. Check your connection and try again.'
      )
    default:
      return translate('bots.errors.generic', 'Something went wrong. Try again.')
  }
}

/** What to type in Discord to ask the bot: its Discord bot's name, else the bot's. */
export function discordMention(bot: Pick<Bot, 'name'>, botName?: string): string {
  return `@${botName || bot.name}`
}

/** "How to ask" in Discord; render it with BotHowToAsk. */
export function discordHowToAsk(bot: Pick<Bot, 'name'>, botName?: string): string {
  return translate(
    'bots.discord.howToAsk',
    'Mention <code>{{mention}}</code> in a channel or thread, or send it a direct message.',
    { mention: discordMention(bot, botName), ...HOW_TO_ASK_ESCAPED }
  )
}
