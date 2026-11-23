import { botTidyUp, patchTidyUp, TIDY_UP_EVERY_CHOICES } from '../bots/bot-tidy-up'
import * as z from 'zod'
import { BOT_IMPORT_REPLY_MAX, BotImportFromSchema } from '../bots/bot-import'
import { AGENT_CHAT_PERMISSION_MODES } from '../agent-launch/permissions/agent-chat-permission-mode'
import {
  BOT_AGENTS,
  BOT_MAX_CONNECTOR_WORKSPACES,
  BOT_MAX_SKILL_PROJECTS,
  BOT_MAX_MEMBERS,
  BotMemberSchema,
  BotItemsStaleSchema,
  BotNameSchema,
  NewBotNameSchema,
  BotNotificationsSchema,
  BotGitHubSchema,
  BotLinearSchema,
  BotSlackAppSchema,
  botMemberSource,
  botSlackApps,
  withoutBotMember,
  withSlackMembersTagged,
  type Bot,
  type BotMember
} from '../bot-types'
import { isSettableBotAvatar, MAX_BOT_AVATAR_BYTES } from '../bot-avatar'
import { BotAvatarColorSchema } from '../bots/bot-avatar-color'
import { BotStoredOutfitSchema } from '../bots/bot-avatar-outfit'
import { botMembersFullError, planBotMemberAdds } from '../bots/bot-member-capacity'
import { HANDED_WORKSPACES_MAX, HandedWorkspaceSchema } from '../bots/bot-made-for-workspaces'
import { BotProposalSchema, BotProposalSeedSchema } from '../bots/bot-proposal'
import { BotTakeOverSchema } from '../bots/bot-take-over'
import { BotLookAroundSchema, botLookAround, patchLookAround } from '../bots/bot-look-around'
import { BotLaunchSchema } from '../bots/bot-launch'
import {
  BOT_OFFER_ALREADY_ANSWERED,
  BotOfferAnswerUpdateSchema,
  withBotOfferAnswer
} from '../bots/bot-offer-answers'
import { type BotCancelledWait, withBotCancelledWait } from '../bots/bot-cancelled-waits'
import { OptionalBoolean, OptionalString, requiredString } from './rpc-param-primitives'
import { ACCESS_REQUEST_TOKEN_PATTERN } from '../connector-bot-access-contract'

/** Why a bots.* call refused. */
export const BOT_ERROR_CODES = [
  'bot_name_taken',
  'bot_not_found',
  'bot_folder_not_owned',
  'bot_avatar_invalid',
  'bot_avatar_changed',
  BOT_OFFER_ALREADY_ANSWERED
] as const

/** A mascot, an emoji or null; an upload is set with bots.avatar.upload. */
const SettableBotAvatar = z
  .string()
  .nullable()
  .refine(isSettableBotAvatar, 'Set an uploaded picture with bots.avatar.upload')

const HandedWorkspaces = z.array(HandedWorkspaceSchema).min(1).max(HANDED_WORKSPACES_MAX)

export const BotCreate = z.object({
  name: NewBotNameSchema,
  agent: z.enum(BOT_AGENTS).optional(),
  /** The model and options picked for `agent`; absent, its chats start on the native chat defaults. */
  launch: BotLaunchSchema.optional(),
  /** Absent, its chats follow the native chat permission default. */
  permissionMode: z.enum(AGENT_CHAT_PERMISSION_MODES).optional(),
  /** Absent, the bot gets a random mascot. */
  avatar: SettableBotAvatar.optional(),
  /** Absent, the mascot's own sky blue. */
  avatarColor: BotAvatarColorSchema.optional(),
  /** Absent, the mascot wears nothing. Any well-formed id, so a newer client's outfit is kept for it. */
  avatarOutfit: BotStoredOutfitSchema.optional(),
  /** Workspaces the owner made it for: its first turn offers to take them over. */
  handOff: HandedWorkspaces.optional(),
  /** Made in Hand to bot: its first turn is the hand-over (`bots.takeOver`), sent once the workspace moved. */
  takingOver: z.literal(true).optional(),
  /** What the new bot is for, from a template or a proposal: seeded into its SOUL.md before its first turn. */
  seed: BotProposalSeedSchema.optional(),
  /** The bot-create card the owner accepted: the proposing bot and that card's id. */
  fromOffer: z.object({ botId: z.string().min(1), offerId: z.string().min(1) }).optional(),
  /** A built-in template the owner reviewed: the host applies its own catalog's package, keeping only the
   *  `skills` the owner left ticked. An id the host doesn't have makes the bot from `seed` alone. */
  fromTemplate: z
    .object({
      id: z.string().min(1).max(64),
      skills: z.array(z.string().min(1).max(64)).max(32)
    })
    .optional(),
  /** With `fromTemplate`: the template's name as the client showed it, in its own language. A bot
   *  still named that gets the folder the template's English name makes; older hosts ignore it. */
  templateNameShown: BotNameSchema.optional(),
  /** A shared link the owner reviewed: the bot is made from exactly that version, or nothing is made.
   *  `toolIds` are the tools the owner ticked. */
  fromShare: z
    .object({
      /** The review the owner opened; main holds what it showed. */
      reviewId: z.uuid(),
      toolIds: z.array(z.string().min(1).max(64)).max(32),
      /** Set by a client that sends the shared mascot's look as it shows it, none included; from an
       *  older client the host takes the package's. */
      lookSent: z.literal(true).optional()
    })
    .optional(),
  /** A bot in another app to bring over: its first turn imports it instead of the usual setup. */
  importFrom: BotImportFromSchema.extend({
    /** The old bot's name, for its first turn. */
    name: z.string().trim().min(1).max(200),
    /** What the old bot wrote back when asked for its setup. */
    reply: z.string().max(BOT_IMPORT_REPLY_MAX).optional()
  }).optional()
})

/** `orca bot create --offer`: a card in the calling bot's chat proposing a new bot; Orca picks its mascot. */
export const BotCreateOfferRequest = BotProposalSchema.omit({ mascot: true }).extend({
  callerSessionId: requiredString("Run this from a bot's chat.")
})

/** Sent to each paired server when a bot is deleted, so its links there go too. */
export const WorktreeReleaseBotHome = z.object({
  botHomeKey: z.string().regex(/^folder:.+/, 'A bot home is a folder workspace key.'),
  /** The computer the home is on: links to it from this server go too. Older senders omit it. */
  installationId: z.string().min(1).optional()
})

const BotMemberKeySchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  workspaceId: z.string().min(1).optional()
})

export const BotUpdate = z.object({
  botId: requiredString('Missing bot id'),
  updates: z
    .object({
      name: BotNameSchema.optional(),
      agent: z.enum(BOT_AGENTS).optional(),
      avatar: SettableBotAvatar.optional(),
      /** null puts back the mascot's own sky blue. */
      avatarColor: BotAvatarColorSchema.nullable().optional(),
      /** null takes the outfit off; any well-formed id is kept, as on create. */
      avatarOutfit: BotStoredOutfitSchema.nullable().optional(),
      paused: z.boolean().optional(),
      sidebarOrder: z.number().int().nonnegative().optional(),
      /** null clears the override. */
      permissionMode: z.enum(AGENT_CHAT_PERMISSION_MODES).nullable().optional(),
      /** null clears it; a new agent without one clears it too, since it belongs to the old agent. */
      launch: BotLaunchSchema.nullable().optional(),
      notifications: BotNotificationsSchema.optional(),
      members: z.array(BotMemberSchema).max(BOT_MAX_MEMBERS).optional(),
      /** Takes one person off Who can ask, on the host, so a concurrent edit is kept. */
      removeMember: BotMemberKeySchema.optional(),
      /** Several people off at once, as removeMember does each (Keep only me). */
      removeMembers: z.array(BotMemberKeySchema).max(BOT_MAX_MEMBERS).optional(),
      /** People added on the host to whoever can ask now, so a concurrent removal isn't undone. */
      addMembers: z.array(BotMemberSchema).max(BOT_MAX_MEMBERS).optional(),
      /** The bot's only Slack workspace; slackApps sets several. */
      slack: BotSlackAppSchema.nullable().optional(),
      slackApps: z.array(BotSlackAppSchema).max(BOT_MAX_CONNECTOR_WORKSPACES).optional(),
      /** The bot's only Linear workspace; linearWorkspaces sets several. */
      linear: BotLinearSchema.nullable().optional(),
      linearWorkspaces: z.array(BotLinearSchema).max(BOT_MAX_CONNECTOR_WORKSPACES).optional(),
      github: BotGitHubSchema.nullable().optional(),
      skillProjects: z.array(z.string().min(1)).max(BOT_MAX_SKILL_PROJECTS).optional(),
      // Only the changed fields; the host merges them into the saved setting.
      lookAround: BotLookAroundSchema.omit({ since: true }).partial().optional(),
      // Only the changed fields, like Look around.
      tidyUp: z
        .object({ on: z.boolean().optional(), every: z.enum(TIDY_UP_EVERY_CHOICES).optional() })
        .optional(),
      /** One card's answer, merged on the host into what the bot has, so answers on other cards are kept.
       *  Applied inside the host's update queue, so a claim is a compare-and-set. */
      offerAnswer: BotOfferAnswerUpdateSchema.optional(),
      itemsStale: BotItemsStaleSchema.optional(),
      slackMirror: z.boolean().optional()
    })
    // Strict so a phone's unknown key fails the phone gate instead of being dropped.
    .strict()
})

/** Projects' skills as a bot would load them; ids that name no project read as missing. */
export const BotSkillProjectsScan = z.object({
  repoIds: z.array(z.string().min(1)).max(500),
  /** Adds this bot's own skills (`own`); older hosts ignore it. */
  botId: z.string().min(1).optional()
})

/** Grant or Decline one waiting Request access ask for a bot on this host. */
export const BotAccessDecide = z.object({
  requestId: z.string().min(1).max(128),
  decision: z.enum(['granted', 'declined'])
})

/** The owner's "Review in Orca" link (orca://bot/<botId>/access-request): its single-use token, and the bot it names. */
export const BotAccessRedeem = z.object({
  token: z.string().regex(ACCESS_REQUEST_TOKEN_PATTERN),
  /** Today's links name no bot; a future one may. */
  botId: requiredString('Missing bot id').optional()
})

export const BotDelete = z.object({
  botId: requiredString('Missing bot id'),
  /** The home folder, soul and memory included, is kept unless this is set. */
  deleteFolder: OptionalBoolean
})

/** A square PNG, base64, that becomes the bot's picture. */
export const BotAvatarUpload = z.object({
  botId: requiredString('Missing bot id'),
  png: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_BOT_AVATAR_BYTES / 3) * 4),
  /** Refused with bot_avatar_changed unless the bot's `avatarRevision` (absent: 0) is still this, checked in
   *  the same step as the write. Sent only to a host with bots.avatar-revision.v1; an older one drops it. */
  expectedAvatarRevision: z.number().int().nonnegative().optional()
})

export const BotAvatarRead = z.object({ botId: requiredString('Missing bot id') })

/** The bot's Activity rows, as its host builds them. */
export const BotActivityRead = z.object({ botId: requiredString('Missing bot id') })

/** The bot's chats with their workers; with `chatId`, that chat's next finished workers after `finishedAfter`. */
export const BotChatTreeRead = z.object({
  botId: requiredString('Missing bot id'),
  chatId: z.string().optional(),
  /** The last finished worker shown (its settledAt and key); absent reads from the newest. */
  finishedAfter: z.object({ at: z.number(), key: z.string() }).optional()
})
export type BotChatTreeParams = z.infer<typeof BotChatTreeRead>

/** Every chat and worker of the bot matched on its host: names, last messages and, with the session
 *  index on, conversation text. */
export const BotChatSearch = z.object({
  botId: requiredString('Missing bot id'),
  query: z.string().min(1).max(200),
  limit: z.number().int().positive().max(100).optional()
})
export type BotChatSearchParams = z.infer<typeof BotChatSearch>

/** Each bot's own side chats; `botIds` answers only those (a notice named them), absent every bot. */
export const BOT_CHATS_OWN_MAX_IDS = 500
export const BotChatsOwn = z.object({
  botIds: z.array(z.string().min(1)).max(BOT_CHATS_OWN_MAX_IDS).optional()
})

/** Chats the owner opened on a client without a reveal (their tab already open); their bot threads stop being new. */
export const BotChatsSeen = z.object({ sessionIds: z.array(z.string().min(1)).max(100) })

/** The bot's Chat: open it (created on first use), or reset it to a new conversation. */
export const BotChat = z.object({ botId: requiredString('Missing bot id') })

/** New Home Chat. `orca bot new-chat` from a bot's own chat names it by that chat instead. */
export const BotChatReset = z.object({
  botId: OptionalString,
  callerSessionId: OptionalString
})

/** A fact to take out of a bot's MEMORY.md, by its words; from a bot's own chat with no botId,
 *  that bot's. */
export const BotMemoryForget = BotChatReset.extend({
  fact: requiredString('Missing fact')
})

/** From Settings: a new fact, or `fact` (its words as they are) reworded to `text`. */
export const BotMemoryEdit = BotChat.extend({
  fact: OptionalString,
  text: requiredString('Missing text')
})

/** One row of a bot's memory history to undo. */
export const BotMemoryUndo = BotChat.extend({ id: requiredString('Missing change id') })

/** A bot's chats; from a bot's own chat with no botId, that bot's, with the calling chat marked. */
export const BotChats = z.object({
  botId: OptionalString,
  callerSessionId: OptionalString,
  /** Closed chats (earlier Home Chats) too. */
  all: OptionalBoolean
})

/** Every bot with what it is for; run from a bot's chat, that bot is marked as itself. */
/** `allComputers`: the paired servers' bots too, after this host's own; `withoutChats`: no Chats
 *  line, so no bot's chats are read. */
export const BotRoster = z.object({
  callerSessionId: OptionalString,
  allComputers: z.boolean().optional(),
  withoutChats: z.boolean().optional()
})

/** A new conversation with the bot; `agent` runs it on another of the agents a bot can be. */
export const BotSessionStart = BotChat.extend({ agent: z.enum(BOT_AGENTS).optional() })

/** The owner handed the bot a workspace, already moved under its home: Orca tells the bot in its Home
 *  (a bot just made for it) or in a new chat. */
export const BotTakeOverParams = BotChat.extend({
  chat: z.enum(['home', 'new']),
  takeOver: BotTakeOverSchema
})

export type BotCreateParams = z.infer<typeof BotCreate>
export type BotUpdateParams = z.infer<typeof BotUpdate>
/** What the host itself may change: an update, or the Google toggle, which only google.bot.set sets. */
export type BotHostUpdates = BotUpdateParams['updates'] &
  Pick<Bot, 'google' | 'acceptedOffers' | 'handedPairedWorkspaces' | 'itemsSeen'> & {
    /** Host-only: a wait of this bot's was cancelled. */
    cancelledWait?: BotCancelledWait
  }
export type BotDeleteParams = z.infer<typeof BotDelete>
export type BotAvatarUploadParams = z.infer<typeof BotAvatarUpload>
export type BotSessionStartParams = z.infer<typeof BotSessionStart>
/** A run that couldn't start, sent again from its card in that chat. */
export const BotRunSendAgainParams = BotChat.extend({
  sessionId: requiredString('Missing session id'),
  runId: requiredString('Missing run id')
})

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
    ...rest
  } = updates
  const next: Bot = { ...bot, ...rest }
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
