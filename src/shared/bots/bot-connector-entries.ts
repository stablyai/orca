// A bot's connectors as one list: each Slack workspace, Linear workspace and GitHub org it is in,
// Google, Webhooks, the apps it signed in to through Composio, and the apps it has as tools. The
// desktop and the phone both list these rows, each from what its own reads say of every service.
import {
  botLinearWorkspaces,
  botMembersFrom,
  botSlackApps,
  type Bot,
  type BotLinear
} from '../bot-types'
import type { BotOwnTool, BotToolProblem } from '../bot-tools'
import { COMPOSIO_SESSION_MCP_URL, type ComposioConnection } from '../composio/composio-apps'
import { composioAppName } from '../composio/composio-curated-apps'
import type { ConnectorGitHubInstallation } from '../connector-bot-github-contract'
import { BOT_MCP_APPS, type BotMcpApp } from './bot-mcp-apps'
import { botToolSubtitle, botToolTitle, isBotUrlTool } from './bot-tool-labels'
import {
  botConnectorTitles,
  type BotConnectorTitle,
  type BotConnectorTitleParts
} from './bot-connector-titles'

/** One Composio sign-in as each side reads it; an older host's has no id. */
type ComposioSignIn = Pick<ComposioConnection, 'app' | 'label'> & {
  id?: string
  name?: string
  status: string
}

/** A tool as each side reads it; the phone's sign-in carries only its state. */
type AppTool = Pick<BotOwnTool, 'name' | 'detail' | 'remote'> & {
  signIn?: { state: NonNullable<BotOwnTool['signIn']>['state'] }
}

/** One remote tool as an app: `app` when it is one Add to <bot> lists, else added by URL. */
export type BotToolApp<Tool extends AppTool = BotOwnTool> = {
  tool: Tool
  app: BotMcpApp | null
  /** What the host's check says is wrong, for the bot's current agent; undefined: all is well. */
  problem: BotToolProblem | undefined
}

/** key: the owner's Composio key is refused or unreadable; unread: the sign-ins couldn't be read. */
export type ComposioProblem = 'key' | 'unread' | null

type UntitledEntry<Connection, Tool extends AppTool> = { key: string; needsOwner: boolean } & (
  | {
      kind: 'slack'
      /** None: its app was removed, but its Slack people remain. */ teamId?: string
      /** Its app is installed but needs Slack's update, not a sign-in. */ updateNeeded?: true
    }
  | { kind: 'linear'; linear: BotLinear }
  | {
      kind: 'github'
      /** None: GitHub as a whole, until it is linked and installed. */ installation?: ConnectorGitHubInstallation
    }
  | { kind: 'google' }
  | { kind: 'webhooks' }
  | { kind: 'composio'; connection: Connection; problem: ComposioProblem }
  /** An app the bot has as a tool: one Add to <bot> lists, or one added by URL. */
  | ({ kind: 'app' } & BotToolApp<Tool>)
  /** Composio is in trouble and no sign-ins are known yet: one row to fix it. */
  | { kind: 'composio-problem'; problem: Exclude<ComposioProblem, null> }
)

/** One row; its title tells it from the bot's other rows of the same service. */
export type BotConnectorEntry<
  Connection extends ComposioSignIn = ComposioConnection,
  Tool extends AppTool = BotOwnTool
> = UntitledEntry<Connection, Tool> & { title: BotConnectorTitle }

/** What each side's reads say of the bot's services, as the list needs it. */
export type BotConnectorFacts<Connection extends ComposioSignIn, Tool extends AppTool> = {
  slack: (teamId: string) => {
    /** Null until its installed workspace is read. */ workspace: string | null
    needsOwner: boolean
    updateNeeded: boolean
  }
  linearNeedsOwner: (workspace: BotLinear) => boolean
  github: {
    /** The orgs Orca is installed in where the host is linked; none until read. */
    installations: readonly ConnectorGitHubInstallation[]
    /** GitHub as a whole needs the owner (shown while no org is). */ needsOwner: boolean
  }
  /** Null until read. */
  google: { emails: readonly string[] } | null
  composio: {
    /** The host's ComposioKeyState (the phone reads it as any string); undefined until read. */
    key: string | undefined
    added: boolean
    /** The last read of the sign-ins failed. */ unread: boolean
    /** Last known when a read fails. */ connections: readonly Connection[]
  }
  /** Null until read. */
  tools: {
    own: readonly Tool[]
    problems: Readonly<Record<string, BotToolProblem>>
  } | null
  words: { webhooks: string; viaComposio: string; composioApps: string; titleSeparator: string }
}

type ConnectorBot = Pick<
  Bot,
  'slack' | 'slackApps' | 'linear' | 'linearWorkspaces' | 'members' | 'github' | 'google'
>

/** URL servers other than Composio's own, which is drawn as its apps. */
export function isBotAppTool(tool: AppTool): boolean {
  return isBotUrlTool(tool) && !COMPOSIO_SESSION_MCP_URL.test(tool.detail)
}

/** Saved values go through Orca's relay, so neither Orca nor its agent's CLI signs in. */
export function botToolAppSignsIn({
  tool,
  app
}: Pick<BotToolApp<AppTool>, 'tool' | 'app'>): boolean {
  return app?.signIn !== 'none' && (tool.signIn !== undefined || tool.remote)
}

/** Command tools stay in Tools; the Composio tool is drawn as its own app rows. */
export function botToolAppsOf<Tool extends AppTool>(
  own: readonly Tool[],
  problems: Readonly<Record<string, BotToolProblem>>
): BotToolApp<Tool>[] {
  return own.filter(isBotAppTool).map((tool) => ({
    tool,
    app: BOT_MCP_APPS.find((app) => app.id === tool.name) ?? null,
    problem: problems[tool.name]
  }))
}

/** Signing in again or fixing a server that won't start is the owner's to do. */
function botToolAppNeedsOwner({ tool, problem }: BotToolApp<AppTool>): boolean {
  if (tool.signIn) {
    return tool.signIn.state !== 'signed-in'
  }
  return problem?.kind === 'sign-in' || problem?.kind === 'failed'
}

/** The list itself, in the order both sides draw it. */
export function botConnectorEntries<Connection extends ComposioSignIn, Tool extends AppTool>(
  bot: ConnectorBot,
  facts: BotConnectorFacts<Connection, Tool>
): BotConnectorEntry<Connection, Tool>[] {
  const { words } = facts
  const entries: UntitledEntry<Connection, Tool>[] = []
  const parts: BotConnectorTitleParts[] = []
  const add = (
    entry: UntitledEntry<Connection, Tool>,
    title: Omit<BotConnectorTitleParts, 'key'>
  ) => {
    entries.push(entry)
    parts.push({ key: entry.key, ...title })
  }
  const slackApps = botSlackApps(bot)
  for (const app of slackApps) {
    const face = facts.slack(app.teamId)
    add(
      {
        kind: 'slack',
        key: `slack:${app.teamId}`,
        teamId: app.teamId,
        needsOwner: face.needsOwner,
        ...(face.updateNeeded ? { updateNeeded: true as const } : {})
      },
      { service: 'Slack', place: face.workspace }
    )
  }
  // People added in Slack stay listed even after the app is removed, so they can be removed too.
  if (slackApps.length === 0 && botMembersFrom(bot.members, 'slack').length > 0) {
    add({ kind: 'slack', key: 'slack', needsOwner: false }, { service: 'Slack' })
  }
  for (const workspace of botLinearWorkspaces(bot)) {
    add(
      {
        kind: 'linear',
        key: `linear:${workspace.workspaceId}`,
        linear: workspace,
        needsOwner: facts.linearNeedsOwner(workspace)
      },
      { service: 'Linear', place: workspace.workspaceName }
    )
  }
  if (bot.github) {
    const removed = bot.github.removedInstallationIds ?? []
    const orgs = facts.github.installations.filter(
      (entry) => !removed.includes(entry.installationId)
    )
    for (const installation of orgs) {
      add(
        {
          kind: 'github',
          key: `github:${installation.installationId}`,
          installation,
          needsOwner: false
        },
        { service: 'GitHub', place: installation.accountLogin }
      )
    }
    if (orgs.length === 0) {
      add(
        { kind: 'github', key: 'github', needsOwner: facts.github.needsOwner },
        { service: 'GitHub' }
      )
    }
  }
  if (bot.google === true && facts.google) {
    const { emails } = facts.google
    // One row for every account, so it names none unless another row is also Google.
    add(
      { kind: 'google', key: 'google', needsOwner: emails.length === 0 },
      { service: 'Google', hints: [emails.join(', ')] }
    )
  }
  // Shown once the bot has a hook; its row hides itself until then.
  add({ kind: 'webhooks', key: 'webhooks', needsOwner: false }, { service: words.webhooks })
  const { composio } = facts
  const problem: ComposioProblem =
    composio.key === 'rejected' || composio.key === 'unreadable'
      ? 'key'
      : composio.unread
        ? 'unread'
        : null
  // Last known when the key or a read fails, so the apps stay listed with what to fix.
  const signIns = composio.connections.filter(
    // A sign-in still under way finishes in the browser; Add a connector shows it waiting.
    (connection) => connection.status !== 'pending'
  )
  for (const connection of signIns) {
    add(
      {
        kind: 'composio',
        key: `composio:${connection.id ?? `${connection.app}:${connection.label ?? ''}`}`,
        connection,
        problem,
        needsOwner: problem !== null || connection.status !== 'active'
      },
      {
        service: composioAppName(connection.app, connection.name),
        hints: [words.viaComposio, connection.label]
      }
    )
  }
  // Nothing known to list, but the bot uses Composio: one row says what's wrong.
  if (signIns.length === 0 && problem && composio.added) {
    add(
      { kind: 'composio-problem', key: 'composio', problem, needsOwner: true },
      { service: words.composioApps }
    )
  }
  for (const app of facts.tools ? botToolAppsOf(facts.tools.own, facts.tools.problems) : []) {
    add(
      { kind: 'app', key: `app:${app.tool.name}`, ...app, needsOwner: botToolAppNeedsOwner(app) },
      {
        service: app.app?.name ?? botToolTitle(app.tool.name),
        hints: [botToolSubtitle(app.tool)]
      }
    )
  }
  const titles = botConnectorTitles(parts, words.titleSeparator)
  return entries.map((entry) => ({ ...entry, title: titles.get(entry.key)! }))
}
