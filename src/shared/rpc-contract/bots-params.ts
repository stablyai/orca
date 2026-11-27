import { botTidyUp, patchTidyUp } from '../bots/bot-tidy-up'
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import {
  BOT_AGENTS,
  botMemberSource,
  botSlackApps,
  withoutBotMember,
  withSlackMembersTagged,
  type Bot,
  type BotMember
} from '../bot-types'
import { botMembersFullError, planBotMemberAdds } from '../bots/bot-member-capacity'
import { BotTakeOverSchema } from '../bots/bot-take-over'
import { botLookAround, patchLookAround } from '../bots/bot-look-around'
import { withBotOfferAnswer } from '../bots/bot-offer-answers'
import { type BotCancelledWait, withBotCancelledWait } from '../bots/bot-cancelled-waits'
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

/** Who can ask after the people an update takes off and adds, applied to the list the host has now.
 *  Throws botMembersFullError, saving nothing, when an add would pass a limit. */
export function applyBotMemberUpdates(
  members: readonly BotMember[],
  updates: Pick<BotUpdateParams['updates'], 'removeMember' | 'removeMembers' | 'addMembers'>
): BotMember[] {
  const { removeMember, removeMembers = [], addMembers = [] } = updates
  let next = [...members]
  for (const key of [...(removeMember ? [removeMember] : []), ...removeMembers]) {
    next = withoutBotMember(next, key)
  }
  const plan = planBotMemberAdds(next, addMembers)
  if (!plan.ok) {
    throw botMembersFullError(plan.full)
  }
  return plan.members
}

/** A null permission mode clears the override, so the bot's chats follow the native chat default. */
export function applyBotUpdates(bot: Bot, updates: BotHostUpdates): Bot {
  const {
    permissionMode,
    launch,
    removeMember,
    removeMembers,
    addMembers,
    lookAround,
    tidyUp,
    offerAnswer,
    cancelledWait,
    lookAtRevision,
    lookAtEpoch,
    ...rest
  } = updates
  const next: Bot = { ...bot, ...rest }
  if (
    bot.generatedOverMascot &&
    lookAtRevision !== undefined &&
    lookAtEpoch === bot.avatarRevisionEpoch &&
    lookAtRevision === (bot.avatarRevision ?? 0) - 1 &&
    updates.avatar === undefined &&
    (updates.avatarColor !== undefined || updates.avatarOutfit !== undefined)
  ) {
    next.avatar = bot.generatedOverMascot
  }
  if (offerAnswer) {
    next.offerAnswers = withBotOfferAnswer(bot.offerAnswers, offerAnswer)
  }
  if (cancelledWait) {
    next.cancelledWaits = withBotCancelledWait(bot.cancelledWaits, cancelledWait)
  }
  if (lookAround) {
    next.lookAround = patchLookAround(botLookAround(bot), lookAround, Date.now())
  }
  if (tidyUp) {
    next.tidyUp = patchTidyUp(botTidyUp(bot), tidyUp, Date.now())
  }
  next.members = applyBotMemberUpdates(next.members, { removeMember, removeMembers, addMembers })
  // `slack` and `linear` mirror the first of their lists, for readers that know one workspace.
  if (rest.slackApps) {
    next.slack = rest.slackApps[0] ?? null
  } else if (rest.slack !== undefined) {
    next.slackApps = rest.slack ? [rest.slack] : []
  }
  if (next.slackApps) {
    // A workspace's people go with it, so a removed workspace never hands them to another.
    // Untagged people are the first workspace's as it was before this update.
    const first = botSlackApps(bot)[0] ?? botSlackApps(next)[0]
    const teams = new Set(next.slackApps.map((app) => app.teamId))
    const tagged = withSlackMembersTagged({
      members: next.members,
      slack: null,
      slackApps: first ? [first] : []
    }).members
    next.members = tagged.filter(
      (member) =>
        botMemberSource(member) !== 'slack' ||
        member.workspaceId === undefined ||
        teams.has(member.workspaceId)
    )
  }
  if (rest.linearWorkspaces) {
    next.linear = rest.linearWorkspaces[0] ?? null
  } else if (rest.linear !== undefined) {
    next.linearWorkspaces = rest.linear ? [rest.linear] : []
  }
  if (permissionMode === null) {
    delete next.permissionMode
  } else if (permissionMode !== undefined) {
    next.permissionMode = permissionMode
  }
  if (launch) {
    next.launch = launch
  } else if (launch === null || (rest.agent !== undefined && rest.agent !== bot.agent)) {
    delete next.launch
  }
  return next
}
