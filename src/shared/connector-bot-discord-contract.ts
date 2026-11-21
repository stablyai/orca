// Mirror of cloud/packages/connector-contract/src/discord-messages.ts for the desktop's reads; a
// broken reason or channel kind this Orca doesn't know reads as a plain string, so a newer cloud's
// never voids an answer.
import * as z from 'zod'
import { optionalConnectorAvatarUrl } from './connector-message-asker'

/** A cloud without the discord routes answers a bare 404; the desktop reads it as Discord not offered yet. */
export const BOT_DISCORD_OFF = 'discord_off'

export const DISCORD_BOT_TOKEN_PATTERN =
  /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/
export const DISCORD_BOT_TOKEN_MAX_LENGTH = 200

/** Where the owner makes the bot's Discord application and copies its token. */
export const DISCORD_DEVELOPER_PORTAL_URL = 'https://discord.com/developers/applications'

// View channels, send messages and send them in threads, attach files, read history: bits 10, 11,
// 15, 16 and 38.
const DISCORD_BOT_PERMISSIONS = '274878008320'

/** Discord's page that adds the bot to a server the person manages; `guildId` preselects one. */
export function discordInviteUrl(applicationId: string, guildId?: string): string {
  const query = new URLSearchParams({
    client_id: applicationId,
    scope: 'bot',
    permissions: DISCORD_BOT_PERMISSIONS
  })
  if (guildId !== undefined) {
    query.set('guild_id', guildId)
    query.set('disable_guild_select', 'true')
  }
  return `https://discord.com/oauth2/authorize?${query.toString()}`
}

/** A pasted token as the portal shows it, without a `Bot ` prefix or quotes copied along; null if it isn't one. */
export function discordBotToken(text: string): string | null {
  const token = text
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/^Bot\s+/i, '')
  return token.length <= DISCORD_BOT_TOKEN_MAX_LENGTH && DISCORD_BOT_TOKEN_PATTERN.test(token)
    ? token
    : null
}

export const ConnectorDiscordGuild = z.object({
  guildId: z.string().min(1),
  name: z.string(),
  iconUrl: z.string().url().optional().catch(undefined)
})
export type ConnectorDiscordGuild = z.infer<typeof ConnectorDiscordGuild>

const DiscordReady = z.object({
  state: z.literal('ready'),
  applicationId: z.string().min(1),
  botUserId: z.string().min(1),
  botName: z.string(),
  ownerUserId: z.string().min(1).optional().catch(undefined),
  ownerName: z.string().optional().catch(undefined),
  guilds: z.array(ConnectorDiscordGuild)
})
const DiscordBroken = z.object({
  state: z.literal('broken'),
  applicationId: z.string().min(1),
  // token_revoked: paste a new token. gateway_closed, or any other: set up again.
  reason: z.string()
})
export const ConnectorBotDiscordState = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_created') }),
  DiscordReady,
  DiscordBroken
])
export type ConnectorBotDiscordState = z.infer<typeof ConnectorBotDiscordState>

const BotId = { botId: z.string().min(1) }

export const ConnectorDiscordBots = z.object({
  bots: z.array(
    z.discriminatedUnion('state', [DiscordReady.extend(BotId), DiscordBroken.extend(BotId)])
  )
})
export type ConnectorDiscordBots = z.infer<typeof ConnectorDiscordBots>
export type ConnectorDiscordBot = ConnectorDiscordBots['bots'][number]

export const ConnectorBotDiscordMembersResponse = z.object({
  members: z.array(
    z.object({ id: z.string(), name: z.string(), avatarUrl: optionalConnectorAvatarUrl })
  ),
  complete: z.boolean()
})
export type ConnectorBotDiscordMembersResponse = z.infer<typeof ConnectorBotDiscordMembersResponse>

export const ConnectorBotDiscordGuildResponse = z.object({
  roles: z.array(z.object({ id: z.string(), name: z.string() })),
  channels: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() }))
})
export type ConnectorBotDiscordGuildResponse = z.infer<typeof ConnectorBotDiscordGuildResponse>
