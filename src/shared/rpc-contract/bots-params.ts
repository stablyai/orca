import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { BOT_AGENTS, type Bot } from '../bot-types'
import { BotTakeOverSchema } from '../bots/bot-take-over'
import type { BotCancelledWait } from '../bots/bot-cancelled-waits'
import type { BotActiveBackup } from '../bots/bot-backup-models'
import { OptionalBoolean, OptionalString, requiredString } from './rpc-param-primitives'
import type { BotCreate, BotDelete, BotUpdate } from './bots-lifecycle-params'

export * from './bots-lifecycle-params'

/** The bot's Activity rows, as its host builds them. */
export const BotActivityRead = lazyZodSchema(() =>
  z.object({ botId: requiredString('Missing bot id') })
)

/** The bot's chats with their workers; with `chatId`, that chat's next finished workers after `finishedAfter`. */
export const BotChatTreeRead = lazyZodSchema(() =>
  z.object({
    botId: requiredString('Missing bot id'),
    chatId: z.string().optional(),
    /** The last finished worker shown (its settledAt and key); absent reads from the newest. */
    finishedAfter: z.object({ at: z.number(), key: z.string() }).optional()
  })
)
export type BotChatTreeParams = z.infer<typeof BotChatTreeRead>

/** Every chat and worker of the bot matched on its host: names, last messages and, with the session
 *  index on, conversation text. */
export const BotChatSearch = lazyZodSchema(() =>
  z.object({
    botId: requiredString('Missing bot id'),
    query: z.string().min(1).max(200),
    limit: z.number().int().positive().max(100).optional()
  })
)
export type BotChatSearchParams = z.infer<typeof BotChatSearch>

/** Each bot's own side chats; `botIds` answers only those (a notice named them), absent every bot. */
export const BOT_CHATS_OWN_MAX_IDS = 500
export const BotChatsOwn = lazyZodSchema(() =>
  z.object({
    botIds: z.array(z.string().min(1)).max(BOT_CHATS_OWN_MAX_IDS).optional()
  })
)

/** Chats the owner opened on a client without a reveal (their tab already open); their bot threads stop being new. */
export const BotChatsSeen = lazyZodSchema(() =>
  z.object({ sessionIds: z.array(z.string().min(1)).max(100) })
)

/** The bot's Chat: open it (created on first use), or reset it to a new conversation. */
export const BotChat = lazyZodSchema(() => z.object({ botId: requiredString('Missing bot id') }))

/** New Home Chat. `orca bot new-chat` from a bot's own chat names it by that chat instead. */
export const BotChatReset = lazyZodSchema(() =>
  z.object({
    botId: OptionalString,
    callerSessionId: OptionalString
  })
)

/** A fact to take out of a bot's MEMORY.md, by its words; from a bot's own chat with no botId,
 *  that bot's. */
export const BotMemoryForget = lazyZodSchema(() =>
  BotChatReset.extend({
    fact: requiredString('Missing fact')
  })
)

/** From Settings: a new fact, or `fact` (its words as they are) reworded to `text`. */
export const BotMemoryEdit = lazyZodSchema(() =>
  BotChat.extend({
    fact: OptionalString,
    text: requiredString('Missing text')
  })
)

/** One row of a bot's memory history to undo. */
export const BotMemoryUndo = lazyZodSchema(() =>
  BotChat.extend({ id: requiredString('Missing change id') })
)

/** A bot's chats; from a bot's own chat with no botId, that bot's, with the calling chat marked. */
export const BotChats = lazyZodSchema(() =>
  z.object({
    botId: OptionalString,
    callerSessionId: OptionalString,
    /** Closed chats (earlier Home Chats) too. */
    all: OptionalBoolean
  })
)

/** Every bot with what it is for; run from a bot's chat, that bot is marked as itself. */
/** `allComputers`: the paired servers' bots too, after this host's own; `withoutChats`: no Chats
 *  line, so no bot's chats are read. */
export const BotRoster = lazyZodSchema(() =>
  z.object({
    callerSessionId: OptionalString,
    allComputers: z.boolean().optional(),
    withoutChats: z.boolean().optional()
  })
)

/** A new conversation with the bot; `agent` runs it on another of the agents a bot can be. */
export const BotSessionStart = lazyZodSchema(() =>
  BotChat.extend({ agent: z.enum(BOT_AGENTS).optional() })
)

/** The owner handed the bot a workspace, already moved under its home: Orca tells the bot in its Home
 *  (a bot just made for it) or in a new chat. */
export const BotTakeOverParams = lazyZodSchema(() =>
  BotChat.extend({
    chat: z.enum(['home', 'new']),
    takeOver: BotTakeOverSchema
  })
)

export type BotCreateParams = z.infer<typeof BotCreate>
export type BotUpdateParams = z.infer<typeof BotUpdate>
/** What the host itself may change: an update, the Google toggle, which only google.bot.set sets,
 *  or the host MCP list, which only bots.tools.setHostMcpServers sets. */
export type BotHostUpdates = BotUpdateParams['updates'] &
  Pick<Bot, 'google' | 'googleAccounts' | 'hostMcpServers'> &
  Pick<Bot, 'acceptedOffers' | 'handedPairedWorkspaces' | 'itemsSeen'> & {
    /** Host-only: a wait of this bot's was cancelled. */
    cancelledWait?: BotCancelledWait
    activeBackup?: BotActiveBackup | null
  }
export type BotDeleteParams = z.infer<typeof BotDelete>
export { BotAvatarRead, BotAvatarUpload, type BotAvatarUploadParams } from './bot-avatar-params'
export type BotSessionStartParams = z.infer<typeof BotSessionStart>
/** A run that couldn't start, sent again from its card in that chat. */
export const BotRunSendAgainParams = lazyZodSchema(() =>
  BotChat.extend({
    sessionId: requiredString('Missing session id'),
    runId: requiredString('Missing run id')
  })
)

export type BotTakeOverParams = z.infer<typeof BotTakeOverParams>
export type BotChatResetParams = z.infer<typeof BotChatReset>

export { applyBotMemberUpdates, applyBotUpdates } from './bots-updates'
