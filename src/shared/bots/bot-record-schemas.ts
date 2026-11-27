import * as z from 'zod'
import { BotImportedFromSchema } from './bot-import'
import { BotSharedFromSchema } from './bot-shared-from'
import { AGENT_CHAT_PERMISSION_MODES } from '../agent-launch/permissions/agent-chat-permission-mode'
import { optionalConnectorAvatarUrl } from '../connector-message-asker'
import type { NativeChatAgent } from '../agent-launch/permissions/agent-chat-permission-support'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host/execution-host'
import { BotLookAroundSchema } from './bot-look-around'
import { BotLaunchSchema } from './bot-launch'
import { BotTidyUpSchema } from './bot-tidy-up'
import { BotOfferAnswerSchema } from './bot-offer-answers'
import { BotCancelledWaitSchema } from './bot-cancelled-waits'
import { BotAvatarColorSchema } from './bot-avatar-color'
import { BotStoredOutfitSchema } from './bot-avatar-outfit'
import { BOT_AGENT_SUCCESSORS, BOT_RETIRED_AGENTS, isBotRetiredAgent } from './bot-retired-agents'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

/** Native-chat agents a bot cannot run on yet; each waits on a live check of its preamble delivery. */
export const BOT_HELD_BACK_AGENTS = [] as const

/** Bots run in a native chat; every native-chat agent but the held-back ones. */
export const BOT_AGENTS = [
  'claude',
  'codex',
  'grok',
  'opencode',
  'omp',
  'pi',
  'antigravity',
  'cursor',
  'hermes',
  'copilot',
  'opencode2',
  'kimi',
  'kiro',
  'aug',
  'goose',
  'kilo',
  'mimo-code',
  'droid',
  'qwen-code',
  'cline',
  'devin',
  'codebuddy'
] as const satisfies readonly Exclude<NativeChatAgent, (typeof BOT_HELD_BACK_AGENTS)[number]>[]

/** A bot agent as old records and peers name it: a retired agent reads as its successor. */
export const BotAgentReadSchema = lazyZodSchema(() =>
  z
    .enum([...BOT_AGENTS, ...BOT_RETIRED_AGENTS])
    .transform((agent): BotAgent =>
      isBotRetiredAgent(agent) ? BOT_AGENT_SUCCESSORS[agent] : agent
    )
)

export const BOT_NAME_MAX_LENGTH = 64
export const BOT_HANDED_PAIRED_WORKSPACES_MAX = 50
export const BOT_MAX_MEMBERS = 200

const BotNameText = lazyZodSchema(() =>
  z
    .string()
    .trim()
    .max(BOT_NAME_MAX_LENGTH)
    // The name is written into the bot's files; a line break would forge their structure.
    .refine((name) => !/\p{Cc}/u.test(name), 'Bot names cannot contain control characters')
)

export const BotNameSchema = lazyZodSchema(() =>
  BotNameText.refine((name) => name.length > 0, 'Missing bot name')
)

/** A new bot's name; empty names it `UNNAMED_BOT_NAME`, numbered past the host's bots that hold it. */
export const NewBotNameSchema = BotNameText

/** A person the owner lets ask the bot, by their user id on one connector's service. */
export const BotMemberSchema = lazyZodSchema(() =>
  z.object({
    id: z.string().min(1),
    name: z.string(),
    /** The connector the id belongs to, e.g. `slack`. Absent on entries saved before sources, which are all Slack; any string, so a newer source never voids the bot. */
    source: z.string().min(1).optional(),
    /** The service's workspace the id belongs to: a Linear workspace, or a Slack team. A Slack entry without one is in the bot's first Slack workspace. */
    workspaceId: z.string().min(1).optional(),
    /** The service's picture of them, as it gave it when they were added; Slack's only. */
    avatarUrl: optionalConnectorAvatarUrl,
    /** `app`: another Slack app's bot user, not a person. Absent for a person; an unknown kind reads as absent, so a newer one never voids the bot. */
    kind: z.literal('app').optional().catch(undefined)
  })
)

export const BotNotificationsSchema = lazyZodSchema(() =>
  z.object({
    needsPermission: z.boolean(),
    taskComplete: z.boolean(),
    couldNotFinish: z.boolean()
  })
)

/** The bot's own Slack app, once created; its install state is read from the cloud. */
export const BotSlackAppSchema = lazyZodSchema(() =>
  z.object({ appId: z.string().min(1), teamId: z.string().min(1) })
)

/** The Linear workspace the bot takes requests in, through Orca's one shared Linear app. */
export const BotLinearSchema = lazyZodSchema(() =>
  z.object({
    workspaceId: z.string().min(1),
    workspaceName: z.string(),
    /** linear.app/<urlKey>, which tells apart workspaces that share a name. */
    urlKey: z.string().optional()
  })
)

/** The bot answers on GitHub, in every installation of Orca's one shared GitHub app the owner's link can see but the removed ones. */
export const BotGitHubSchema = lazyZodSchema(() =>
  z.object({
    removedInstallationIds: z.array(z.string().min(1)).max(100).optional()
  })
)

/** The account a link was made under; absent on links made before owners were recorded. */
const createBotLinkOwner = () => ({ ownerUserId: z.string().min(1).optional() })

/** Workspaces one connector can hold for a bot. */
export const BOT_MAX_CONNECTOR_WORKSPACES = 8
export const BOT_MAX_SKILL_PROJECTS = 20
const BotSlackLinkSchema = lazyZodSchema(() => BotSlackAppSchema.extend(createBotLinkOwner()))
const BotLinearLinkSchema = lazyZodSchema(() => BotLinearSchema.extend(createBotLinkOwner()))

/** Its choices in order, as Settings offers them. */
export const BOT_ITEMS_STALE_CHOICES = [3, 5, 7, 14, 'never'] as const
export const BotItemsStaleSchema = lazyZodSchema(() =>
  z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(14), z.literal('never')])
)
export type BotItemsStale = z.infer<typeof BotItemsStaleSchema>

export const BotSchema = lazyZodSchema(() =>
  z.object({
    id: z.string().min(1),
    name: BotNameSchema,
    /** v1 bots live on this computer; SSH and WSL hosts come later. */
    hostId: z.literal(LOCAL_EXECUTION_HOST_ID),
    /** The home's name in ~/.orca/bots, reserved at create; never a path, so it cannot point outside. */
    folder: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    /** The bot's home folder workspace, in the hidden Bots project group. */
    folderWorkspaceId: z.string().min(1),
    agent: z.enum(BOT_AGENTS),
    avatar: z.string().nullable(),
    /** The mascot's tile color; absent or null, its own sky blue. Older hosts drop it. */
    avatarColor: BotAvatarColorSchema.nullable().optional().catch(undefined),
    /** What the mascot wears; absent or null, nothing. Kept as stored: one this version doesn't know draws
     *  as none (wornBotOutfit) but survives a save, for the version that added it. */
    avatarOutfit: BotStoredOutfitSchema.nullable().optional().catch(undefined),
    /** Mascot replaced by an automatic upload at the current revision. */
    generatedOverMascot: z.string().optional().catch(undefined),
    /** Bumped by every picture, color or outfit write, so a write can require that none landed since it was
     *  asked for (bots.avatar.upload `expectedAvatarRevision`). Absent is 0; older hosts drop it. */
    avatarRevision: z.number().int().nonnegative().optional().catch(undefined),
    /** Rotated when an explicit picture choice repairs a lost revision history. */
    avatarRevisionEpoch: z.uuid().optional().catch(undefined),
    paused: z.boolean(),
    /** An owner's override; absent, the bot's chats start like any native chat. */
    permissionMode: z.enum(AGENT_CHAT_PERMISSION_MODES).optional(),
    /** The owner's model and options for `agent`; absent on older bots and dropped by older hosts. */
    // A malformed value reads as unset rather than losing the whole bot.
    launch: BotLaunchSchema.optional().catch(undefined),
    notifications: BotNotificationsSchema,
    members: z.array(BotMemberSchema).max(BOT_MAX_MEMBERS),
    /** The first of slackApps, kept for readers that know one workspace (older Orcas, the phone). */
    slack: BotSlackLinkSchema.nullable(),
    /** Every Slack workspace the bot is in, first one first; absent on bots saved before several. */
    slackApps: z.array(BotSlackLinkSchema).max(BOT_MAX_CONNECTOR_WORKSPACES).optional(),
    /** The first of linearWorkspaces, as `slack` is of slackApps. */
    linear: BotLinearLinkSchema.nullable().default(null),
    linearWorkspaces: z.array(BotLinearLinkSchema).max(BOT_MAX_CONNECTOR_WORKSPACES).optional(),
    github: BotGitHubSchema.extend(createBotLinkOwner()).nullable().default(null),
    /** Whether a new Slack thread the owner starts posts the owner's Orca messages back to it; absent is on.
     *  Threads others start, and the owner's teammates' DMs, start off whatever this says. */
    slackMirror: z.boolean().optional().catch(undefined),
    /** The bot may use the Google accounts signed in on its host, for its owner's own requests. Absent is off. */
    google: z.boolean().optional(),
    /** The accounts it may use while `google` is on; absent is every account, now and later. A malformed
     *  list reads as none, never as every account. */
    googleAccounts: z.array(z.string().min(1).max(320)).max(100).optional().catch([]),
    /** Its sessions also take the host's MCP server list (and so its sign-ins); absent is off. Only
     *  bots.tools.setHostMcpServers sets it, never the bot itself. Older hosts drop it. */
    hostMcpServers: z.boolean().optional().catch(undefined),
    /** Projects (repo ids) whose skills the bot loads when a chat starts; absent is none. */
    skillProjects: z.array(z.string().min(1)).max(BOT_MAX_SKILL_PROJECTS).optional(),
    /** Its place in the sidebar's Bots list, set by a drag; a bot without one follows the placed bots. */
    sidebarOrder: z.number().int().nonnegative().optional(),
    /** The bot's Chat, its one ongoing conversation; null until first opened. */
    chatSessionId: z.string().min(1).nullable().default(null),
    /** Look around, once changed; absent is on with the defaults. Older hosts drop it. */
    // A malformed value reads as unset rather than losing the whole bot.
    lookAround: BotLookAroundSchema.optional().catch(undefined),
    /** Nightly Tidy-up of its memory, once turned off (by its owner, or after it kept failing);
     *  absent is on. Older hosts drop it. */
    tidyUp: BotTidyUpSchema.optional().catch(undefined),
    /** Days an untouched ask waits before it moves to Stale (planned items 3× as long), or never;
     *  absent is 5. Older hosts drop it. */
    itemsStale: BotItemsStaleSchema.optional().catch(undefined),
    /** The newest item event its owner has seen in its Items tab; absent is none. Older hosts drop it. */
    itemsSeen: z.number().int().nonnegative().optional().catch(undefined),
    /** Set at create: the Chat runs first-run setup until SOUL.md is written. Older bots never have it. */
    firstRun: z.literal(true).optional(),
    /** New bots its owner created from this bot's bot-create cards, by card, so each card stays Created
     *  however the new bot is renamed, and can't create a second one. */
    acceptedOffers: z
      .array(z.object({ offerId: z.string().min(1), botId: z.string().min(1) }))
      .optional()
      .catch(undefined),
    /** What its owner answered on its offer cards, by card. */
    offerAnswers: z.array(BotOfferAnswerSchema).optional().catch(undefined),
    /** Workspaces on a paired computer its owner handed it: their store holds the link, so Activity
     *  asks that computer for their agents. An entry whose workspace moved elsewhere is dropped. */
    handedPairedWorkspaces: z
      .array(
        z.object({
          environmentId: z.string().min(1),
          worktreeId: z.string().min(1),
          /** When it was handed over: only a computer's answer asked after this can prove a move away. */
          at: z.number().optional()
        })
      )
      .max(BOT_HANDED_PAIRED_WORKSPACES_MAX)
      .optional()
      .catch(undefined),
    /** Its waits cancelled before they ended, newest last. */
    cancelledWaits: z.array(BotCancelledWaitSchema).optional().catch(undefined),
    /** The other app's bot it was made from, so importing that bot again offers this one. */
    importedFrom: BotImportedFromSchema.optional().catch(undefined),
    /** The shared link it was made from. */
    sharedFrom: BotSharedFromSchema.optional().catch(undefined),
    /** The built-in template it was made from. */
    templateId: z.string().max(64).optional().catch(undefined),
    createdAt: z.number(),
    updatedAt: z.number()
  })
)

export type BotAgent = (typeof BOT_AGENTS)[number]
export type BotMember = z.infer<typeof BotMemberSchema>
export type BotNotifications = z.infer<typeof BotNotificationsSchema>
export type BotSlackApp = z.infer<typeof BotSlackAppSchema>
export type BotLinear = z.infer<typeof BotLinearSchema>
export type BotGitHub = z.infer<typeof BotGitHubSchema>
export type Bot = z.infer<typeof BotSchema>
export type BotSlackLink = z.infer<typeof BotSlackLinkSchema>
export type BotLinearLink = z.infer<typeof BotLinearLinkSchema>
