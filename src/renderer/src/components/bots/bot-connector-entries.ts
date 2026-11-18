// A bot's connectors as one list: each Slack workspace, Linear workspace and GitHub org it is in,
// Google, Webhooks, the apps it signed in to through Composio, and the apps it has as tools. Settings and the bot page's
// Connectors tab list these rows; Needs you and the tab count the ones that need the owner.
import { useMemo } from 'react'
import { botTarget, ownBotHost } from '@/lib/bot-hosts'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useBotGitHub } from '@/lib/bot-github-state'
import { useBotLinear } from '@/lib/bot-linear-state'
import { useBotSlack } from '@/lib/bot-slack-state'
import {
  botLinearWorkspaces,
  botMembersFrom,
  botSlackApps,
  type Bot,
  type BotLinear
} from '../../../../shared/bot-types'
import type { ComposioConnection } from '../../../../shared/composio/composio-apps'
import { botToolsSupported } from '../../../../shared/bot-tools'
import type { BotGitHubView } from '@/lib/bot-github-state'
import type { BotLinearView } from '@/lib/bot-linear-state'
import type { BotSlackView } from '@/lib/bot-slack-state'
import type { GoogleHostView } from './google/google-connect-client'
import type { ComposioBotView } from './composio/composio-client'
import type { ConnectorGitHubInstallation } from '../../../../shared/connector-bot-github-contract'
import { useComposioBot } from './composio/composio-client'
import { botToolAppNeedsOwner, botToolApps, type BotToolApp } from './apps/bot-tool-apps'
import { useBotTools, type BotToolsCheck, type BotToolsView } from './bot-tool-checks'
import { gitHubCardFace } from './github/BotGitHubCard'
import { useGoogleHost } from './google/google-connect-client'
import { linearCardFace } from './linear/BotLinearCard'
import { slackCardFace } from './slack/BotSlackCard'
import {
  botConnectorTitles,
  type BotConnectorTitle,
  type BotConnectorTitleParts
} from './bot-connector-titles'
import { botToolSubtitle, botToolTitle } from '../../../../shared/bots/bot-tool-labels'
import { translate } from '@/i18n/i18n'
import { composioAppName } from '../../../../shared/composio/composio-curated-apps'

type UntitledEntry = { key: string; needsOwner: boolean } & (
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
  | { kind: 'composio'; connection: ComposioConnection; problem: ComposioProblem }
  /** An app the bot has as a tool: one Add to <bot> lists, or one added by URL. */
  | ({ kind: 'app' } & BotToolApp)
  /** Composio is in trouble and no sign-ins are known yet: one row to fix it. */
  | { kind: 'composio-problem'; problem: Exclude<ComposioProblem, null> }
)

/** key: the owner's Composio key is refused or unreadable; unread: the sign-ins couldn't be read. */
export type ComposioProblem = 'key' | 'unread' | null

/** What the list is built from: the stores each connector's row reads. */
export type BotConnectorSources = {
  slack: BotSlackView
  linear: BotLinearView
  github: BotGitHubView
  google: GoogleHostView
  composio: ComposioBotView
  tools: BotToolsView
}

/** One row; its title tells it from the bot's other rows of the same service. */
export type BotConnectorEntry = UntitledEntry & { title: BotConnectorTitle }

const NO_ENTRIES: BotConnectorEntry[] = []

/**
 * The bot's connector rows in list order; null (no bot shown) reads nothing. Only a shown list
 * checks its apps' sign-ins (`apps`); counts and badges take a check it already ran (`finished`).
 */
export function useBotConnectorEntries(
  bot: Bot | null,
  appsCheck: Extract<BotToolsCheck, 'apps' | 'finished'> = 'finished'
): BotConnectorEntry[] {
  const shown = bot !== null
  const slack = useBotSlack(bot)
  const hostId = bot?.hostId ?? ownBotHost().hostId
  const linear = useBotLinear(hostId, shown)
  const github = useBotGitHub(hostId, shown)
  // No bot shown reads nothing, so the host it would read is only a placeholder.
  const google = useGoogleHost(bot ? botTarget(bot) : ownBotHost().target, shown)
  const composio = useComposioBot(bot)
  const { view: tools } = useBotTools(bot && botToolsSupported(bot.agent) ? bot : null, appsCheck)
  // Changes with the UI language, so the translated titles follow a switch.
  const t = useTranslate()
  // The panel header, tab and toggle all read it, so one list per change of its sources.
  return useMemo(
    () =>
      bot
        ? botConnectorEntries(bot, { slack, linear, github, google, composio, tools }, t)
        : NO_ENTRIES,
    [bot, slack, linear, github, google, composio, tools, t]
  )
}

/** The list itself, from the bot and its sources. */
export function botConnectorEntries(
  bot: Bot,
  { slack, linear, github, google, composio, tools }: BotConnectorSources,
  t: Translate = translate
): BotConnectorEntry[] {
  const entries: UntitledEntry[] = []
  const parts: BotConnectorTitleParts[] = []
  const add = (entry: UntitledEntry, title: Omit<BotConnectorTitleParts, 'key'>): void => {
    entries.push(entry)
    parts.push({ key: entry.key, ...title })
  }
  const slackApps = botSlackApps(bot)
  for (const app of slackApps) {
    const face = slackCardFace(slack, app.teamId, null)
    add(
      {
        kind: 'slack',
        key: `slack:${app.teamId}`,
        teamId: app.teamId,
        // Can't check (signed in elsewhere aside) is not the owner's to fix.
        needsOwner: face.next !== null && face.next !== 'retry',
        ...(face.next === 'update' ? { updateNeeded: true as const } : {})
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
        needsOwner: linearCardFace(workspace, linear, null).status?.tone === 'attention'
      },
      { service: 'Linear', place: workspace.workspaceName }
    )
  }
  if (bot.github) {
    const removed = bot.github.removedInstallationIds ?? []
    const orgs =
      github.status === 'ready' && github.github.account
        ? github.github.installations.filter((entry) => !removed.includes(entry.installationId))
        : []
    if (orgs.length > 0) {
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
    } else {
      add(
        {
          kind: 'github',
          key: 'github',
          needsOwner: gitHubCardFace(github, null).status?.tone === 'attention'
        },
        { service: 'GitHub' }
      )
    }
  }
  if (bot.google === true) {
    const accounts = google.status === 'ready' ? google.google.accounts : []
    add(
      {
        kind: 'google',
        key: 'google',
        needsOwner: google.status === 'ready' && accounts.length === 0
      },
      // One row for every account, so it names none unless another row is also Google.
      { service: 'Google', hints: [accounts.map((account) => account.email).join(', ')] }
    )
  }
  // Shown once the bot has a hook; its row hides itself until then.
  add(
    { kind: 'webhooks', key: 'webhooks', needsOwner: false },
    { service: t('bots.webhooks.name', 'Webhooks') }
  )
  const key = composio.status?.key
  const problem: ComposioProblem =
    key === 'rejected' || key === 'unreadable' ? 'key' : composio.error ? 'unread' : null
  // Last known when the key or a read fails, so the apps stay listed with what to fix.
  const signIns = (composio.connections?.connections ?? []).filter(
    // A sign-in still under way finishes in the browser; Add a connector shows it waiting.
    (connection) => connection.status !== 'pending'
  )
  for (const connection of signIns) {
    add(
      {
        kind: 'composio',
        key: `composio:${connection.id}`,
        connection,
        problem,
        needsOwner: problem !== null || connection.status !== 'active'
      },
      {
        service: composioAppName(connection.app, connection.name),
        hints: [t('bots.composio.viaComposio', 'via Composio'), connection.label]
      }
    )
  }
  // Nothing known to list, but the bot uses Composio: one row says what's wrong.
  if (signIns.length === 0 && problem && composio.status?.added) {
    add(
      { kind: 'composio-problem', key: 'composio', problem, needsOwner: true },
      { service: t('bots.composio.toolName', 'Composio apps') }
    )
  }
  for (const app of botToolApps(tools)) {
    add(
      { kind: 'app', key: `app:${app.tool.name}`, ...app, needsOwner: botToolAppNeedsOwner(app) },
      {
        service: app.app?.name ?? botToolTitle(app.tool.name),
        hints: [botToolSubtitle(app.tool)]
      }
    )
  }
  const titles = botConnectorTitles(parts)
  return entries.map((entry): BotConnectorEntry => ({ ...entry, title: titles.get(entry.key)! }))
}
