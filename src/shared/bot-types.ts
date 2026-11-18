import * as z from 'zod'
import { BotImportedFromSchema } from './bots/bot-import'
import { BotSharedFromSchema } from './bots/bot-shared-from'
import { AGENT_CHAT_PERMISSION_MODES } from './agent-launch/permissions/agent-chat-permission-mode'
import { optionalConnectorAvatarUrl } from './connector-message-asker'
import type { NativeChatAgent } from './agent-launch/permissions/agent-chat-permission-support'
import { LOCAL_EXECUTION_HOST_ID } from './execution-host/execution-host'
import { BotLookAroundSchema } from './bots/bot-look-around'
import { BotLaunchSchema } from './bots/bot-launch'
import { BotTidyUpSchema } from './bots/bot-tidy-up'
import { BotOfferAnswerSchema } from './bots/bot-offer-answers'
import { BotCancelledWaitSchema } from './bots/bot-cancelled-waits'

/** Native-chat agents a bot cannot run on yet; each waits on a live check of its preamble delivery. */
export const BOT_HELD_BACK_AGENTS = ['opencode2', 'copilot', 'cursor', 'kimi', 'hermes'] as const

/** Bots run in a native chat; every native-chat agent but the held-back ones. */
export const BOT_AGENTS = [
  'claude',
  'codex',
  'grok',
  'opencode',
  'omp',
  'pi',
  'antigravity'
] as const satisfies readonly Exclude<NativeChatAgent, (typeof BOT_HELD_BACK_AGENTS)[number]>[]

export function isBotAgent(agent: string): agent is BotAgent {
  return BOT_AGENTS.some((entry) => entry === agent)
}

export const BOT_NAME_MAX_LENGTH = 64
export const BOT_HANDED_PAIRED_WORKSPACES_MAX = 50
export const BOT_MAX_MEMBERS = 200

const BotNameText = z
  .string()
  .trim()
  .max(BOT_NAME_MAX_LENGTH)
  // The name is written into the bot's files; a line break would forge their structure.
  .refine((name) => !/\p{Cc}/u.test(name), 'Bot names cannot contain control characters')

export const BotNameSchema = BotNameText.refine((name) => name.length > 0, 'Missing bot name')

/** A new bot's name; empty names it `UNNAMED_BOT_NAME`, numbered past the host's bots that hold it. */
export const NewBotNameSchema = BotNameText

export const UNNAMED_BOT_NAME = 'New bot'

/** `requested`, or with none "New bot", else the first free "New bot 2", "New bot 3"… among `bots`. */
export function newBotName(requested: string, bots: readonly { name: string }[]): string {
  if (requested.trim()) {
    return requested.trim()
  }
  const used = new Set(bots.map((bot) => bot.name.toLowerCase()))
  let name = UNNAMED_BOT_NAME
  for (let n = 2; used.has(name.toLowerCase()); n += 1) {
    name = `${UNNAMED_BOT_NAME} ${n}`
  }
  return name
}

/** A person the owner lets ask the bot, by their user id on one connector's service. */
export const BotMemberSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** The connector the id belongs to, e.g. `slack`. Absent on entries saved before sources, which are all Slack; any string, so a newer source never voids the bot. */
  source: z.string().min(1).optional(),
  /** The service's workspace the id belongs to: a Linear workspace, or a Slack team. A Slack entry without one is in the bot's first Slack workspace. */
  workspaceId: z.string().min(1).optional(),
  /** The service's picture of them, as it gave it when they were added; Slack's only. */
  avatarUrl: optionalConnectorAvatarUrl
})

export const BotNotificationsSchema = z.object({
  needsPermission: z.boolean(),
  taskComplete: z.boolean(),
  couldNotFinish: z.boolean()
})

/** The bot's own Slack app, once created; its install state is read from the cloud. */
export const BotSlackAppSchema = z.object({ appId: z.string().min(1), teamId: z.string().min(1) })

/** The Linear workspace the bot takes requests in, through Orca's one shared Linear app. */
export const BotLinearSchema = z.object({
  workspaceId: z.string().min(1),
  workspaceName: z.string(),
  /** linear.app/<urlKey>, which tells apart workspaces that share a name. */
  urlKey: z.string().optional()
})

/** The bot answers on GitHub, in every installation of Orca's one shared GitHub app the owner's link can see but the removed ones. */
export const BotGitHubSchema = z.object({
  removedInstallationIds: z.array(z.string().min(1)).max(100).optional()
})

/** The account a link was made under; absent on links made before owners were recorded. */
const BotLinkOwner = { ownerUserId: z.string().min(1).optional() }

/** Workspaces one connector can hold for a bot. */
export const BOT_MAX_CONNECTOR_WORKSPACES = 8
export const BOT_MAX_SKILL_PROJECTS = 20
const BotSlackLinkSchema = BotSlackAppSchema.extend(BotLinkOwner)
const BotLinearLinkSchema = BotLinearSchema.extend(BotLinkOwner)

export const BotItemsStaleSchema = z.union([
  z.literal(3),
  z.literal(5),
  z.literal(7),
  z.literal(14),
  z.literal('never')
])
export type BotItemsStale = z.infer<typeof BotItemsStaleSchema>

export const BotSchema = z.object({
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
  github: BotGitHubSchema.extend(BotLinkOwner).nullable().default(null),
  /** Whether a new Slack thread the owner starts posts the owner's Orca messages back to it; absent is on.
   *  Threads others start, and the owner's teammates' DMs, start off whatever this says. */
  slackMirror: z.boolean().optional().catch(undefined),
  /** The bot may use the Google accounts signed in on its host, for its owner's own requests. Absent is off. */
  google: z.boolean().optional(),
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

export type BotAgent = (typeof BOT_AGENTS)[number]
export type BotMember = z.infer<typeof BotMemberSchema>
export type BotNotifications = z.infer<typeof BotNotificationsSchema>
export type BotSlackApp = z.infer<typeof BotSlackAppSchema>
export type BotLinear = z.infer<typeof BotLinearSchema>
export type BotGitHub = z.infer<typeof BotGitHubSchema>
export type Bot = z.infer<typeof BotSchema>
export type BotSlackLink = z.infer<typeof BotSlackLinkSchema>
export type BotLinearLink = z.infer<typeof BotLinearLinkSchema>

/** Every Slack workspace the bot is in, first one first. */
export function botSlackApps(bot: Pick<Bot, 'slack' | 'slackApps'>): BotSlackLink[] {
  return bot.slackApps ?? (bot.slack ? [bot.slack] : [])
}

/** Every Linear workspace the bot takes requests in, first one first. */
export function botLinearWorkspaces(
  bot: Pick<Bot, 'linear' | 'linearWorkspaces'>
): BotLinearLink[] {
  return bot.linearWorkspaces ?? (bot.linear ? [bot.linear] : [])
}

/** Whether the cloud can bring the bot work: a Slack app, a Linear workspace or a GitHub link. */
export function botHasConnector(
  bot: Pick<Bot, 'slack' | 'slackApps' | 'linear' | 'linearWorkspaces' | 'github'>
): boolean {
  return botSlackApps(bot).length > 0 || botLinearWorkspaces(bot).length > 0 || bot.github !== null
}

/**
 * Slack people saved before workspaces, tagged with the bot's first Slack workspace, the only one
 * there was. Untouched without a Slack workspace (they show on a row of their own).
 */
export function withSlackMembersTagged<T extends Pick<Bot, 'members' | 'slack' | 'slackApps'>>(
  bot: T
): T {
  const first = botSlackApps(bot)[0]?.teamId
  return first === undefined ||
    !bot.members.some((member) => botMemberSource(member) === 'slack' && !member.workspaceId)
    ? bot
    : {
        ...bot,
        members: bot.members.map((member) =>
          botMemberSource(member) === 'slack' && !member.workspaceId
            ? { ...member, source: 'slack', workspaceId: first }
            : member
        )
      }
}

/** The Slack people allowed to ask the bot in one of its Slack workspaces. */
export function slackMembersOf(
  bot: Pick<Bot, 'slack' | 'slackApps'> & { members: readonly BotMember[] },
  teamId: string
): BotMember[] {
  const first = botSlackApps(bot)[0]?.teamId
  return botMembersFrom(bot.members, 'slack').filter((member) =>
    member.workspaceId === undefined ? teamId === first : member.workspaceId === teamId
  )
}

export function botMemberSource(member: BotMember): string {
  return member.source ?? 'slack'
}

/** The people one connector's service lets ask the bot. */
export function botMembersFrom(members: readonly BotMember[], source: string): BotMember[] {
  return members.filter((member) => botMemberSource(member) === source)
}

/** One person on a connector's service, as Who can ask names them for removal. */
export type BotMemberKey = Pick<BotMember, 'id' | 'workspaceId'> & { source: string }

/** Everyone but that person; a key without a workspace matches them in every workspace of the service. */
export function withoutBotMember(members: readonly BotMember[], key: BotMemberKey): BotMember[] {
  return members.filter(
    (member) =>
      member.id !== key.id ||
      botMemberSource(member) !== key.source ||
      (key.workspaceId !== undefined && member.workspaceId !== key.workspaceId)
  )
}

/** The Linear people allowed to ask the bot in one Linear workspace. */
export function linearMembersOf(members: readonly BotMember[], workspaceId: string): BotMember[] {
  return botMembersFrom(members, 'linear').filter((member) => member.workspaceId === workspaceId)
}

/**
 * GitHub people saved before orgs had rows, put in each org the bot is in now (`installationIds`,
 * less the removed ones), so an org added later starts with nobody and a removal is per org.
 */
export function withGitHubMembersTagged<T extends Pick<Bot, 'members' | 'github'>>(
  bot: T,
  installationIds: readonly string[]
): T {
  const removed = bot.github?.removedInstallationIds ?? []
  const orgs = installationIds.filter((id) => !removed.includes(id))
  const untagged = (member: BotMember) =>
    botMemberSource(member) === 'github' && member.workspaceId === undefined
  if (!bot.github || orgs.length === 0 || !bot.members.some(untagged)) {
    return bot
  }
  return {
    ...bot,
    members: bot.members.flatMap((member) =>
      untagged(member) ? orgs.map((workspaceId) => ({ ...member, workspaceId })) : [member]
    )
  }
}

/** The GitHub people allowed to ask the bot in one installation; one saved with none (not yet tagged), in every one. */
export function gitHubMembersOf(
  members: readonly BotMember[],
  installationId: string
): BotMember[] {
  return botMembersFrom(members, 'github').filter(
    (member) => member.workspaceId === undefined || member.workspaceId === installationId
  )
}

/** Drops unreadable records rather than failing the whole profile load. */
export function normalizePersistedBots(value: unknown): Bot[] {
  if (!Array.isArray(value)) {
    return []
  }
  const bots: Bot[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    const parsed = BotSchema.safeParse(candidate)
    if (parsed.success && !seen.has(parsed.data.id)) {
      seen.add(parsed.data.id)
      bots.push(withSlackMembersTagged(parsed.data))
    }
  }
  return bots
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/

/** A folder name every supported filesystem accepts. */
export function botFolderName(botName: string): string {
  const slug = botName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  if (!slug) {
    return 'bot'
  }
  return WINDOWS_RESERVED_NAME.test(slug) ? `${slug}-bot` : slug
}
