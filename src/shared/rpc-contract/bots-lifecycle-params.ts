import { TIDY_UP_EVERY_CHOICES } from '../bots/bot-tidy-up'
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
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
  BotSlackAppSchema
} from '../bot-types'
import { SettableBotAvatar } from './bot-avatar-params'
import { BotAvatarColorSchema } from '../bots/bot-avatar-color'
import { BotStoredOutfitSchema } from '../bots/bot-avatar-outfit'
import { HANDED_WORKSPACES_MAX, HandedWorkspaceSchema } from '../bots/bot-made-for-workspaces'
import { BotProposalSchema, BotProposalSeedSchema } from '../bots/bot-proposal'
import { BotLookAroundPatchSchema } from '../bots/bot-look-around'
import { BotLaunchSchema } from '../bots/bot-launch'
import { BOT_OFFER_ALREADY_ANSWERED, BotOfferAnswerUpdateSchema } from '../bots/bot-offer-answers'
import { OptionalBoolean, requiredString } from './rpc-param-primitives'
import { ACCESS_REQUEST_TOKEN_PATTERN } from '../connector-bot-access-contract'

/** Why a bots.* call refused. */
export const BOT_ERROR_CODES = [
  'bot_name_taken',
  'bot_not_found',
  'bot_folder_not_owned',
  'bot_avatar_invalid',
  'bot_avatar_changed',
  'bot_avatar_home_unreadable',
  BOT_OFFER_ALREADY_ANSWERED
] as const

const HandedWorkspaces = lazyZodSchema(() =>
  z.array(HandedWorkspaceSchema).min(1).max(HANDED_WORKSPACES_MAX)
)

export const BotCreate = lazyZodSchema(() =>
  z.object({
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
)

/** `orca bot create --offer`: a card in the calling bot's chat proposing a new bot; Orca picks its mascot. */
export const BotCreateOfferRequest = lazyZodSchema(() =>
  BotProposalSchema.omit({ mascot: true }).extend({
    callerSessionId: requiredString("Run this from a bot's chat.")
  })
)

/** Sent to each paired server when a bot is deleted, so its links there go too. */
export const WorktreeReleaseBotHome = lazyZodSchema(() =>
  z.object({
    botHomeKey: z.string().regex(/^folder:.+/, 'A bot home is a folder workspace key.'),
    /** The computer the home is on: links to it from this server go too. Older senders omit it. */
    installationId: z.string().min(1).optional()
  })
)

const BotMemberKeySchema = lazyZodSchema(() =>
  z.object({
    id: z.string().min(1),
    source: z.string().min(1),
    workspaceId: z.string().min(1).optional()
  })
)

export const BotUpdate = lazyZodSchema(() =>
  z.object({
    botId: requiredString('Missing bot id'),
    updates: z
      .object({
        name: BotNameSchema.optional(),
        agent: z.enum(BOT_AGENTS).optional(),
        avatar: SettableBotAvatar.optional(),
        /** The mascot revision visible when its color or outfit was picked. */
        lookAtEpoch: z.uuid().optional(),
        lookAtRevision: z.number().int().nonnegative().optional(),
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
        lookAround: BotLookAroundPatchSchema.optional(),
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
)

/** Projects' skills as a bot would load them; ids that name no project read as missing. */
export const BotSkillProjectsScan = lazyZodSchema(() =>
  z.object({
    repoIds: z.array(z.string().min(1)).max(500),
    /** Adds this bot's own skills (`own`); older hosts ignore it. */
    botId: z.string().min(1).optional()
  })
)

/** Grant or Decline one waiting Request access ask for a bot on this host. */
export const BotAccessDecide = lazyZodSchema(() =>
  z.object({
    requestId: z.string().min(1).max(128),
    decision: z.enum(['granted', 'declined'])
  })
)

/** The owner's "Review in Orca" link (orca://bot/<botId>/access-request): its single-use token, and the bot it names. */
export const BotAccessRedeem = lazyZodSchema(() =>
  z.object({
    token: z.string().regex(ACCESS_REQUEST_TOKEN_PATTERN),
    /** Today's links name no bot; a future one may. */
    botId: requiredString('Missing bot id').optional()
  })
)

export const BotDelete = lazyZodSchema(() =>
  z.object({
    botId: requiredString('Missing bot id'),
    /** The home folder, soul and memory included, is kept unless this is set. */
    deleteFolder: OptionalBoolean
  })
)
