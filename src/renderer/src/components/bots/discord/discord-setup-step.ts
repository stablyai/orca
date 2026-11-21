// Which screen Discord setup shows, from the host's Discord bots and the owner's choices so far.
import { botDiscordState, type BotDiscordView } from '@/lib/bot-discord-state'
import {
  BOT_DISCORD_OFF,
  type ConnectorDiscordGuild
} from '../../../../../shared/connector-bot-discord-contract'

export type BotDiscordSetupStep =
  | { kind: 'checking' }
  | { kind: 'failed'; code: string }
  /** Paste the bot token from Discord's Developer Portal; `broken` when the last one stopped working. */
  | { kind: 'token'; broken: string | null }
  /** The Discord bot works: add it to a server, and wait for Discord to say it joined. */
  | { kind: 'invite'; applicationId: string; botName: string }
  | { kind: 'done'; guilds: ConnectorDiscordGuild[]; botName: string }

export function botDiscordSetupStep(
  view: BotDiscordView,
  botId: string,
  /** `newToken`: the owner chose to paste another token. `known`: the servers the bot was in when this
   *  setup began, so one it joins since reads as done (null until read). `target`: a server row being
   *  repaired, done once its bot works there again. */
  choice: { newToken: boolean; known: readonly string[] | null; target: string | null }
): BotDiscordSetupStep {
  if (view.status === 'loading') {
    return { kind: 'checking' }
  }
  if (view.status !== 'ready') {
    return { kind: 'failed', code: view.status === 'off' ? BOT_DISCORD_OFF : view.error }
  }
  const state = botDiscordState(view, botId)
  if (state.state !== 'ready' || choice.newToken) {
    return { kind: 'token', broken: state.state === 'broken' ? state.reason : null }
  }
  const { known, target } = choice
  const joined = known === null ? [] : state.guilds.filter((g) => !known.includes(g.guildId))
  const repaired = state.guilds.filter((guild) => guild.guildId === target)
  const done = joined.length > 0 ? joined : repaired
  return done.length > 0
    ? { kind: 'done', guilds: done, botName: state.botName }
    : { kind: 'invite', applicationId: state.applicationId, botName: state.botName }
}
