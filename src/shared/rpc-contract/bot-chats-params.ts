// A bot's chats: listing them, marking them seen, and opening a closed one again.
import * as z from 'zod'
import { OptionalBoolean, OptionalString, requiredString } from './rpc-param-primitives'

/** Each bot's own side chats; `botIds` answers only those (a notice named them), absent every bot. */
export const BOT_CHATS_OWN_MAX_IDS = 500
export const BotChatsOwn = z.object({
  botIds: z.array(z.string().min(1)).max(BOT_CHATS_OWN_MAX_IDS).optional()
})

/** Chats the owner opened on a client without a reveal (their tab already open); their bot threads stop being new. */
export const BotChatsSeen = z.object({ sessionIds: z.array(z.string().min(1)).max(100) })

/** A bot's chats; from a bot's own chat with no botId, that bot's, with the calling chat marked. */
export const BotChats = z.object({
  botId: OptionalString,
  callerSessionId: OptionalString,
  /** Closed chats (earlier Home Chats, closed run chats) too. */
  all: OptionalBoolean
})

/** Opens one of the bot's closed chats again, by the id `orca bot chats --all` prints. */
export const BotChatReopen = BotChats.omit({ all: true }).extend({
  chatId: requiredString('Missing --chat')
})
