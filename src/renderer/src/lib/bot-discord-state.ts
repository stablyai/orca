// Each host account's bots with their own Discord bot, as Orca Cloud reports them, read on demand and
// shared by every Discord surface for that host (createConnectorHostState).
import {
  BOT_DISCORD_OFF,
  type ConnectorBotDiscordState,
  type ConnectorDiscordBots
} from '../../../shared/connector-bot-discord-contract'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../shared/connector-bot-slack-contract'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { botDiscordCalls } from './bot-connector-host-calls'
import { createConnectorHostState } from './connector-host-state'

/** `off`: the cloud has no Discord yet, so every Discord surface reads "Coming soon". */
export type BotDiscordView =
  | { status: 'loading' }
  | { status: 'off' }
  | { status: 'ready'; discord: ConnectorDiscordBots }
  | { status: 'failed'; error: string }

async function askDiscord(hostId: ExecutionHostId): Promise<BotDiscordView> {
  try {
    const result = await botDiscordCalls(hostId).bots()
    return result.ok
      ? { status: 'ready', discord: result.value }
      : result.error === BOT_DISCORD_OFF
        ? { status: 'off' }
        : { status: 'failed', error: result.error }
  } catch {
    return { status: 'failed', error: BOT_SLACK_DESKTOP_ERRORS.failed }
  }
}

const discord = createConnectorHostState<BotDiscordView>({
  loading: { status: 'loading' },
  ask: askDiscord,
  // Which bots have a Discord bot, whether it works, and the servers it is in.
  shape: (view) =>
    view.status === 'ready'
      ? JSON.stringify(
          view.discord.bots.map((bot) => [
            bot.botId,
            bot.state,
            bot.state === 'ready' ? bot.guilds.map((guild) => guild.guildId) : []
          ])
        )
      : null,
  // Discord's add-to-server page never sends the browser back to a page Orca watches.
  returnUrl: () => null
})

export const readBotDiscord = discord.read
export const refreshBotDiscord = discord.refresh
/** Follows the host's Discord bots until one changes, e.g. while the owner adds one to a server. */
export const awaitDiscordChange = discord.awaitChange
export const useDiscordAwait = discord.useAwait
export const stopAwaitingDiscord = discord.stopAwaiting
export const useBotDiscordHost = discord.useView

/** One bot's own Discord bot in a host's answer; not_created when the cloud lists none. */
export function botDiscordState(view: BotDiscordView, botId: string): ConnectorBotDiscordState {
  if (view.status !== 'ready') {
    return { state: 'not_created' }
  }
  const listed = view.discord.bots.find((entry) => entry.botId === botId)
  if (!listed) {
    return { state: 'not_created' }
  }
  const { botId: _botId, ...state } = listed
  return state
}
