// A Discord server in a bot's record (BotSchema's `discord`), and the limits the owner set there.
import * as z from 'zod'

/** Roles, and channels, a Discord server's limits name at most. */
export const BOT_MAX_DISCORD_LIMITS = 50

const DiscordNamed = z.object({ id: z.string().min(1), name: z.string() })

/** A Discord server the bot's own Discord bot is in, and its limits: holders of `roles` may ask it
 *  too, beside its people; `channels`, when any, are the only ones it answers in. */
export const BotDiscordGuildSchema = z.object({
  guildId: z.string().min(1),
  guildName: z.string(),
  roles: z.array(DiscordNamed).max(BOT_MAX_DISCORD_LIMITS).optional(),
  channels: z.array(DiscordNamed).max(BOT_MAX_DISCORD_LIMITS).optional()
})
