import { migrateRetiredBotAgent } from './bots/bot-retired-agents'
import {
  BOT_AGENTS,
  BotSchema,
  type Bot,
  type BotAgent,
  type BotLinearLink,
  type BotMember,
  type BotSlackLink
} from './bots/bot-record-schemas'

export {
  BOT_HELD_BACK_AGENTS,
  BOT_AGENTS,
  BotAgentReadSchema,
  BOT_NAME_MAX_LENGTH,
  BOT_HANDED_PAIRED_WORKSPACES_MAX,
  BOT_MAX_MEMBERS,
  BotNameSchema,
  NewBotNameSchema,
  BotMemberSchema,
  BotNotificationsSchema,
  BotSlackAppSchema,
  BotLinearSchema,
  BotGitHubSchema,
  BOT_MAX_CONNECTOR_WORKSPACES,
  BOT_MAX_SKILL_PROJECTS,
  BotItemsStaleSchema,
  BOT_ITEMS_STALE_CHOICES,
  BotSchema,
  type BotAgent,
  type BotItemsStale,
  type BotMember,
  type BotNotifications,
  type BotSlackApp,
  type BotLinear,
  type BotGitHub,
  type Bot,
  type BotSlackLink,
  type BotLinearLink
} from './bots/bot-record-schemas'

/** Agents the previous release's bot schema reads; it drops bots on any other agent when it loads. */
const BOT_AGENTS_OLDER_BUILDS_READ: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'grok',
  'opencode',
  'omp',
  'pi',
  'antigravity'
])

/** Bots saved where an older build, after a rollback, cannot drop them: it ignores keys it does not know. */
export function splitBotsByOlderBuildSupport(bots: readonly Bot[]): {
  readable: Bot[]
  newer: Bot[]
} {
  const readable: Bot[] = []
  const newer: Bot[] = []
  for (const bot of bots) {
    const side = BOT_AGENTS_OLDER_BUILDS_READ.has(bot.agent) ? readable : newer
    side.push(bot)
  }
  return { readable, newer }
}

export function isBotAgent(agent: string): agent is BotAgent {
  return BOT_AGENTS.some((entry) => entry === agent)
}

/** Memory upkeep runs tool-free, so every bot agent runs it; Look around is `lookAroundSupported`. */
export function tidyUpSupported(agent: string): boolean {
  return isBotAgent(agent)
}

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
    const parsed = BotSchema.safeParse(migrateRetiredBotAgent(candidate))
    if (parsed.success && !seen.has(parsed.data.id)) {
      seen.add(parsed.data.id)
      bots.push(withSlackMembersTagged(parsed.data))
    }
  }
  return bots
}

export { botFolderName } from './bots/bot-folder-name'
